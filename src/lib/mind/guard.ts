/**
 * The gate. Every write a model proposes passes through here or does not happen.
 *
 * WHY THIS IS NOT JUST "ASK THE USER FIRST"
 *
 * The instinct is to confirm everything a model wants to do, and it is the wrong
 * instinct. Anthropic ran a study with about a thousand people: when a permission
 * prompt was swapped for a plainly dangerous command, **13.6% of them approved
 * it**, against 89% refused by their automated mode. A confirmation dialog is
 * not a safety mechanism when it appears several times a turn; it is a rhythm
 * people learn to click through, and the tenth one is not read.
 *
 * So this file does not ask. It decides, with rules that do not depend on the
 * model's cooperation or the user's attention:
 *
 *   - the tool must exist, in a catalog with nothing generic in it;
 *   - the arguments must satisfy the schema, and a name must resolve against
 *     what the interface is already showing;
 *   - a write proposed from untrusted content is refused outright;
 *   - exactly one class of action stops to ask: `destructive`.
 *
 * And `destructive` is a much smaller class than it sounds, because this app's
 * removal goes to a trash with a seven-day restore. `delete_task` and
 * `forget_memory` ask; everything that adds, logs or completes does not. Asking
 * about a reversible action is how a confirmation gate becomes noise.
 *
 * WHAT MAKES THE 13.6% SURVIVABLE
 *
 * The trash. Every removal is one click from coming back, so the worst case of a
 * wrong `destructive` decision is a visible, recoverable one. That is the
 * property to preserve: if a future action cannot be undone, it belongs in a
 * stricter class than this one, not in this one.
 *
 * NEVER THROWS. A validator that throws is a validator every caller has to
 * wrap, and the refusal reasons are the entire value of the function.
 */

import type { ActionIntent, LifeState } from "../core/types";
import { findTool, type ToolSpec } from "./tools";

export interface Proposal {
  tool: string;
  args: Record<string, unknown>;
}

export type Verdict =
  | { verdict: "allow"; intent: ActionIntent; spec: ToolSpec; toolCallId?: string }
  | { verdict: "confirm"; intent: ActionIntent; spec: ToolSpec; question: string; toolCallId?: string }
  | { verdict: "refuse"; reason: string; toolCallId?: string };

export interface GuardContext {
  lifeState: LifeState;
  /** Set when the proposal came from content Xana did not write. Fail-closed. */
  untrustedSource?: string;
  toolCallId?: string;
}

/**
 * Check the arguments against the spec's own JSON Schema.
 *
 * Only the two constraints that actually prevent a bad write are enforced:
 * `required` must be present and non-empty, and a value given for a declared
 * property must be the declared type. A full JSON Schema implementation would be
 * a dependency and a new class of bug for no gain — the handlers re-validate
 * everything they use anyway, and this layer's job is to stop the obviously
 * malformed call before a handler has to.
 *
 * `required: []` is honoured rather than treated as "nothing required": a tool
 * like `log_health` declares no required fields on purpose because any one
 * measurement is a valid call, and the handler refuses the all-empty case with a
 * sentence that names the fields.
 */
function schemaErrors(spec: ToolSpec, args: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const params = spec.parameters as {
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };

  for (const key of params.required ?? []) {
    const value = args[key];
    if (value === undefined || value === null || value === "") {
      errors.push(`"${key}" is required`);
      continue;
    }
    if (typeof value === "string" && value.trim().length === 0) errors.push(`"${key}" is required`);
  }

  for (const [key, value] of Object.entries(args)) {
    const declared = params.properties?.[key];
    if (!declared?.type || value === undefined || value === null) continue;
    const expected = declared.type;
    const actual = Array.isArray(value) ? "array" : typeof value;
    const matches =
      expected === actual ||
      // JSON has one number type; "integer" is a description of the value, and
      // `log_health`'s sleepHours is a number that is usually whole.
      (expected === "number" && actual === "number") ||
      (expected === "integer" && actual === "number" && Number.isInteger(value));
    if (!matches) errors.push(`"${key}" should be ${expected}, got ${actual}`);
  }

  return errors;
}

/**
 * The one gate.
 *
 * Order matters and is deliberate: existence, then trust, then shape, then
 * resolution, then the confirmation class. A write from untrusted content is
 * refused before its arguments are even looked at, so there is no path where a
 * well-formed poisoned call is treated differently from a malformed one.
 */
export function validateActionIntent(proposal: Proposal, ctx: GuardContext): Verdict {
  const toolCallId = ctx.toolCallId;

  try {
    const spec = findTool(proposal.tool);
    if (!spec) {
      return { verdict: "refuse", reason: `there is no tool named "${proposal.tool}"`, toolCallId };
    }

    if (spec.safety === "read") {
      // Reads change nothing and carry no arguments worth validating, so they
      // are allowed outright - including from untrusted content, because the
      // danger is a write, and refusing a read would only make her less able to
      // answer without making anything safer.
      return {
        verdict: "allow",
        intent: { type: "none" },
        spec,
        toolCallId,
      };
    }

    if (ctx.untrustedSource) {
      return {
        verdict: "refuse",
        reason: `that instruction came from ${ctx.untrustedSource}, which I do not take orders from`,
        toolCallId,
      };
    }

    const args = proposal.args ?? {};
    const errors = schemaErrors(spec, args);
    if (errors.length > 0) {
      return { verdict: "refuse", reason: `bad arguments: ${errors.join("; ")}`, toolCallId };
    }

    /**
     * Resolution is checked here as well as in the handler.
     *
     * Duplicated on purpose. The handler's resolution produces the id; this one
     * produces the *refusal*, and it has to happen before a `destructive` tool
     * can reach the point of asking a question. A confirmation that says "remove
     * the deck review?" when no such task exists is worse than a refusal: the
     * user says yes and learns the assistant does not know what is in the list.
     */
    for (const need of spec.resolves ?? []) {
      const phrase = args[need.arg];
      if (typeof phrase !== "string" || phrase.trim().length === 0) {
        return { verdict: "refuse", reason: `"${need.arg}" is required`, toolCallId };
      }
    }

    const result = spec.handler(args, { lifeState: ctx.lifeState, sessionId: "" });
    if (!result.ok) return { verdict: "refuse", reason: result.error, toolCallId };
    if (!result.intent) {
      // A write tool that produced no intent is a bug in this repo, not a
      // model error, and executing "nothing" is the safe reading either way.
      return { verdict: "refuse", reason: `"${proposal.tool}" produced no action`, toolCallId };
    }

    if (spec.safety === "destructive") {
      return {
        verdict: "confirm",
        intent: result.intent,
        spec,
        question: questionFor(spec, result.data),
        toolCallId,
      };
    }

    return { verdict: "allow", intent: result.intent, spec, toolCallId };
  } catch (err) {
    return {
      verdict: "refuse",
      reason: `I could not check that (${err instanceof Error ? err.message : String(err)})`,
      toolCallId,
    };
  }
}

/**
 * What the user is asked before a destructive action lands.
 *
 * The name comes from the *handler's resolved title*, not from the model's
 * argument, and that is the point: the model proposes "the dentist thing" and
 * the question has to say which task that turned out to be, so a wrong
 * resolution is visible before it happens rather than after.
 */
function questionFor(spec: ToolSpec, data: unknown): string {
  const resolved =
    data && typeof data === "object"
      ? ((data as Record<string, unknown>).task ??
        (data as Record<string, unknown>).memory ??
        (data as Record<string, unknown>).title)
      : undefined;
  const what = typeof resolved === "string" && resolved.trim() ? `"${resolved.trim()}"` : "that";

  if (spec.name === "forget_memory") return `Forget ${what}? It goes to the bin, and I can put it back.`;
  if (spec.name === "delete_task") return `Remove ${what}? It goes to the bin for seven days.`;
  return `Do that to ${what}? It goes to the bin, and I can put it back.`;
}

/* ------------------------------------------------------------------ */
/* Reading a yes or a no                                               */
/* ------------------------------------------------------------------ */

/**
 * Is this reply a yes?
 *
 * Kept next to the gate because the two have to agree: if a question is asked
 * and the answer cannot be recognised, the confirmation is not a gate, it is a
 * dead end. An affirmation is read from the *opening* of the message rather than
 * searched for, so "no, you're right, don't" is not a yes because it contains
 * one.
 */
const AFFIRMATIVE =
  /^(?:yes|yeah|yep|yup|ok|okay|sure|please do|do it|go ahead|confirm|confirmed|that'?s? right|correct|affirmative|absolutely|fine)\b/i;

const NEGATIVE =
  /^(?:no|nope|nah|don'?t|do not|stop|cancel|never ?mind|forget it|leave it|that'?s? wrong|not that|hold on|wait)\b/i;

export function isAffirmation(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // A denial wins outright: "no, go ahead" is a refusal of the offer, and
  // reading it as consent is the one mistake this pair must not make.
  if (NEGATIVE.test(t)) return false;
  return AFFIRMATIVE.test(t);
}

export function isDenial(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (AFFIRMATIVE.test(t) && !NEGATIVE.test(t)) return false;
  return NEGATIVE.test(t);
}
