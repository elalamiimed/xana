/**
 * The agent loop: the model proposes, this file disposes.
 *
 * THE DECISION THIS FILE IMPLEMENTS
 *
 * Xana's oldest rule is that intent resolution happens locally, always, so a
 * model can never invent a write that lands in the database (MEMORY.md section
 * 1). That rule is why she is trustworthy and why she works with no key. It is
 * also exactly why she felt limited: anything the local engine did not match
 * produced a refusal, and the model was explicitly forbidden from helping.
 *
 * This loop is the narrow, deliberate amendment. It runs **only** when the local
 * engine matched nothing, and what it grants the model is not the ability to act
 * - it is the ability to *ask for one of a closed set of typed things*, each of
 * which was already reachable by typing a sentence:
 *
 *     model proposes  ->  guard.validateActionIntent  ->  executeAction
 *                          (closed catalog,              (the one commit path,
 *                           schema, resolution,           audit row, idempotency
 *                           untrusted-source refusal)     key, remote mirror)
 *
 * Every property that mattered is still true. There is one write path. A write
 * is byte-identical whether the model or the local engine asked for it. The app
 * still works fully with no key, because with no key this file is never called.
 *
 * WHAT IT DOES NOT DO
 *
 * The loop is capped at `MAX_TOOL_ROUNDS`, refuses every tool that is not in the
 * catalog, and never lets a proposal from untrusted content through. It also
 * never *retries* a failed call on its own initiative: a refusal is reported to
 * the model as a result, and the model decides what to say about it. A loop that
 * retried would be a loop that could double-write, which is what the idempotency
 * key exists to make impossible rather than merely unlikely.
 *
 * NEVER THROWS. The caller is a conversation, and an exception here would be a
 * 500 in the chat window instead of a sentence.
 */

import type { ActionIntent, ActionOutcome, Card, LifeState, Message } from "../core/types";
import { localMind } from "./local";
import { llmAvailable, llmComplete, type LlmMessage, type LlmToolCall } from "./llm";
import { validateActionIntent, isAffirmation, isDenial, type Proposal } from "./guard";
import { parseToolArguments, recoverTextToolCalls, stripToolMarkup, toolsJsonSchema, READ_TOOLS, WRITE_TOOLS, ALL_TOOLS } from "./tools";
import { actionRule } from "./claims";
import { composePersona } from "./persona";
import { isCasual, conversationalSystemPrompt } from "./casual";
import { stripMarkdown, shapeForModality } from "./voice";
import { loadSettings } from "../settings/store";
import { nowIso } from "../core/time";
import { hash32 } from "../core/vector";
import { executeAction } from "../actions/executor";
import { renderLifeState } from "./render";

/** Round trips per turn: one to propose, then one per correction, then a bound. */
export const MAX_TOOL_ROUNDS = 4;

export interface AgentTurnInput {
  text: string;
  lifeState: LifeState;
  sessionId: string;
  modality?: "text" | "voice";
  /** Skip the context refresh (scripts that want a pure function). */
  noRefresh?: boolean;
}

export interface AgentToolCallRecord {
  name: string;
  ok: boolean;
  effect?: string;
  /** Present on a refusal, so a test can name the reason. */
  reason?: string;
}

export interface AgentTurnResult {
  text: string;
  cards?: Card[];
  outcome?: ActionOutcome;
  toolCalls: AgentToolCallRecord[];
  engine: "agent" | "local";
}

/* ------------------------------------------------------------------ */
/* Pending confirmations                                               */
/* ------------------------------------------------------------------ */

interface Pending {
  intent: ActionIntent;
  tool: string;
  question: string;
  askedAt: number;
}

/**
 * Destructive proposals waiting for a yes.
 *
 * In memory, keyed by session, with a short expiry, and that is a deliberate
 * choice rather than a shortcut. A pending confirmation is a *conversational*
 * state - "shall I remove the deck review?" - and persisting it across a restart
 * would mean Xana could open a conversation by executing a question the user
 * asked yesterday and has since forgotten. Losing it on restart costs one
 * repeated sentence. Keeping it costs a surprise deletion.
 */
const pending = new Map<string, Pending>();

/** How long a question stays open. Long enough to answer, short enough to expire. */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export function clearPending(sessionId: string): void {
  pending.delete(sessionId);
}

function takePending(sessionId: string): Pending | undefined {
  const entry = pending.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.askedAt > CONFIRMATION_TTL_MS) {
    pending.delete(sessionId);
    return undefined;
  }
  return entry;
}

/**
 * Answer an outstanding confirmation, if there is one.
 *
 * Called before anything else in a turn. Two reasons it is not part of the loop:
 * a "yes" must execute the *exact* intent that was approved rather than letting
 * the model re-derive it from a rephrased request, and a "no" must be
 * acknowledgeable without a model round trip at all.
 *
 * Returns `undefined` when there is nothing pending, which is the common case.
 */
export function resolvePendingConfirmation(input: {
  text: string;
  sessionId: string;
  lifeState: LifeState;
}): AgentTurnResult | undefined {
  const entry = takePending(input.sessionId);
  if (!entry) return undefined;

  if (isDenial(input.text)) {
    pending.delete(input.sessionId);
    return {
      text: "Left it alone.",
      toolCalls: [{ name: entry.tool, ok: false, reason: "declined" }],
      engine: "agent",
    };
  }

  if (!isAffirmation(input.text)) {
    // Neither a yes nor a no: the question is not answered, but the subject may
    // have moved on. Re-asking on every subsequent message is how a gate
    // becomes a nag, so it is dropped and the turn proceeds normally.
    pending.delete(input.sessionId);
    return undefined;
  }

  pending.delete(input.sessionId);

  /**
   * Re-validated at execution time, not trusted from when it was asked.
   *
   * Five minutes is long enough for the thing being removed to have been
   * removed by hand, or for the task to have been completed. Re-running the
   * gate against the *current* life state means a stale "yes" refuses rather
   * than acting on a proposal that no longer describes reality.
   */
  const recheck = validateActionIntent(
    { tool: entry.tool, args: pendingArgsOf(entry.intent) },
    { lifeState: input.lifeState },
  );
  if (recheck.verdict === "refuse") {
    return {
      text: `That no longer applies - ${recheck.reason}.`,
      toolCalls: [{ name: entry.tool, ok: false, reason: recheck.reason }],
      engine: "agent",
    };
  }

  const intent = recheck.verdict === "allow" ? recheck.intent : entry.intent;
  const outcome = executeProposal(intent, entry.tool, input.sessionId, "confirmed");
  return {
    text: outcome.message || "Done.",
    outcome,
    toolCalls: [{ name: entry.tool, ok: outcome.ok, effect: outcome.effect }],
    engine: "agent",
  };
}

/**
 * The arguments a stored intent would have come from.
 *
 * Only needed so the re-check has something schema-shaped to look at; the
 * intent itself is what executes. Kept total rather than partial so a
 * destructive intent can never fail the re-check for a missing field it never
 * carried.
 */
function pendingArgsOf(intent: ActionIntent): Record<string, unknown> {
  const anyIntent = intent as unknown as Record<string, unknown>;
  return {
    task: anyIntent.taskId,
    memory: anyIntent.memoryId,
    title: anyIntent.title,
  };
}

/* ------------------------------------------------------------------ */
/* The idempotency key                                                 */
/* ------------------------------------------------------------------ */

/**
 * A key derived from the server's own identifiers.
 *
 * `sessionId + toolCallId` is stable for a given tool call and unrelated to
 * anything the model wrote, which is what makes it trustworthy: the model
 * cannot choose its own key, so it cannot choose to collide with - or avoid -
 * the one that already landed. A retried request, a duplicated round trip, or a
 * provider that echoes a call twice all produce the same key, and the database's
 * unique index makes the second one a no-op.
 *
 * `hash32` is used rather than a full digest because this has to be cheap and is
 * not a security boundary: the UNIQUE index is the guarantee, and this is only
 * the value it compares.
 */
export function idempotencyKeyFor(sessionId: string, toolCallId: string): string {
  return `m${hash32(`${sessionId}|${toolCallId}`).toString(16)}`;
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

function executeProposal(
  intent: ActionIntent,
  tool: string,
  sessionId: string,
  toolCallId: string,
): ActionOutcome {
  return executeAction(intent, {
    sessionId,
    source: "model",
    tool,
    /**
     * The key is derived from identifiers the server owns, never from anything
     * the model wrote. That is what makes it trustworthy: a model cannot choose
     * to collide with - or dodge - the key that already landed, so a retried
     * request or a provider that echoes the same call twice produces the same
     * key and the second write is a no-op.
     */
    idempotencyKey: idempotencyKeyFor(sessionId, toolCallId),
  });
}

/* ------------------------------------------------------------------ */
/* The prompt                                                          */
/* ------------------------------------------------------------------ */

/**
 * What the model reads before it proposes anything.
 *
 * The life state is rendered by `./render`, which the calling module also uses,
 * so the two can never disagree about what the model was told.
 */
function systemPromptFor(): string {
  const settings = loadSettings();
  const persona = composePersona(settings.voice.persona);
  const parts = [persona];

  const name = settings.identity.name.trim();
  if (name) parts.push(`You are speaking with ${name}. Use their name sparingly - once is usually enough.`);
  const location = settings.identity.location.trim();
  if (location) parts.push(`They are in ${location}.`);

  const today = new Date();
  parts.push(
    `Today is ${today.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })}.`,
  );

  /**
   * The rule about tools, stated where it cannot be missed.
   *
   * The failure this prevents is the one `./claims` was written for, one layer
   * up: a model told to be helpful will narrate a completed action it did not
   * take. Having real tools makes that *more* likely, not less, because a model
   * that can see `create_task` in its catalog will describe calling it. The
   * ACTION RESULT wording is reused from `./claims` so the two cannot drift.
   */
  parts.push(`YOUR TOOLS

Read (change nothing - call these to find out what is true):
${READ_TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n")}

Write (these actually change something):
${WRITE_TOOLS.map((t) => `- ${t.name}: ${t.description}${t.safety === "destructive" ? " [I will ask them to confirm first]" : ""}`).join("\n")}

How to use them:
- Call ONE tool at a time, then read its result before deciding what next.
- **Look before you say you do not know.** If they ask about their list, goals, calendar, energy, habits or what they remember, CALL THE READ TOOL. Answering "I do not have that" while a tool that could have told you sits unused is a wrong answer wearing the costume of an honest one - and it happened: asked what her goals looked like, she said nothing was filed that way without ever calling get_goals.
- Call a tool ONLY for something they actually asked for. Never call one to look busy, never call the same one twice for the same request.
- Name things the way the user did: "the deck review", not an id. If a tool refuses because a name did not match, say so plainly and ask which one they meant - do not try another name and hope.
- A name that matches nothing is a refusal, not an error to work around.

Goals, specifically - this is where it is easiest to be unhelpful:
- "I want to be fit this year" is the START of a conversation, not a request to file a row. Ask what it means to them and how often they will actually train, and only then build the plan.
- **Do not create a goal as a receipt.** Opening with "it's on the board now" when they asked you to help them plan is filing a container and calling it help. Propose the substance first.
- When you do have enough, call \`plan_goal\` to get dated milestones, offer the shape in a sentence or two, and save with \`create_goal\` only once they agree to it.
- A goal's \`title\` is a few words - "Get properly fit", not the sentence they typed. It goes on a board next to other short titles.
- A goal with no milestones and no meaning attached is not a plan, it is a placeholder. If that is genuinely all you have, say so rather than presenting it as progress.

After a tool returns, tell them what happened in one short sentence. Do not narrate the call or read out the raw result.

${actionRule(false)}`);

  return parts.join("\n\n");
}

/* ------------------------------------------------------------------ */
/* The loop                                                            */
/* ------------------------------------------------------------------ */

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const toolCalls: AgentToolCallRecord[] = [];

  /**
   * The offline path, first and unconditional.
   *
   * With no model configured this returns immediately, and that is the
   * acceptance criterion the whole design rests on: no key means no loop, not a
   * slower loop.
   */
  if (!llmAvailable()) {
    const local = localMind({ text: input.text, lifeState: input.lifeState, sessionId: input.sessionId });
    return { text: local.text, cards: local.cards, outcome: local.outcome, toolCalls, engine: "local" };
  }

  /**
   * Talk, answered as talk, with no tools offered.
   *
   * The routing decision lives in `./casual`, and it is deliberately biased:
   * anything resembling a request takes the tool path, because a request
   * misread as conversation means a change silently does not happen - the same
   * class of failure as a model claiming "Done." when nothing ran.
   *
   * A fall-through rather than a return, because a model that returns nothing
   * useful for a conversational turn should still get the tool loop's attempt
   * rather than having a refusal handed to the user.
   */
  if (isCasual(input.text)) {
    const spoken = await runConversationTurn(input);
    if (spoken) return spoken;
  }

  const messages: LlmMessage[] = [
    { role: "system", content: systemPromptFor() },
    { role: "user", content: `LIFE STATE\n${renderLifeState(input.lifeState)}\n\nUSER SAID: ${input.text}` },
  ];

  let outcome: ActionOutcome | undefined;
  let text = "";
  /** One line per round, kept only so a failed turn can explain itself. */
  const roundLog: string[] = [];
  let rounds = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    rounds = round + 1;
    let completion;
    try {
      completion = await llmComplete(messages, {
        /**
         * Generous, because `max_tokens` counts the thinking tokens too.
         *
         * Thinking mode is on, and its reasoning is billed against the same
         * budget as the answer. At 1200 the model could spend the whole
         * allowance on chain-of-thought and return an empty `content` with
         * `finish_reason: "length"` - which is not an error, so nothing threw,
         * and the loop fell through to the local engine's "I didn't follow
         * that". A real turn was lost that way: asked to compare a goal against
         * a task list, she called the read tool correctly and then answered with
         * the old refusal, because the answer had been truncated to nothing.
         *
         * The cap is a ceiling, not a reservation: a short reply still costs a
         * short reply. It is set well above any sentence she has ever produced
         * so the truncation mode is out of reach rather than merely unlikely.
         */
        maxTokens: 4000,
        tools: toolsJsonSchema(),
        toolChoice: "auto",
        thinking: true,
      });
    } catch (err) {
      /**
       * A failed round trip ends the loop honestly.
       *
       * If a write already landed this turn, the reply has to describe *that*
       * rather than an apology, because the user's instruction was carried out
       * and only the narration failed. Saying "I lost the connection" over a
       * task that was created is the mirror of the lie `./claims` guards.
       */
      if (outcome?.ok) {
        return {
          text: outcome.message || fallbackLine(outcome),
          outcome,
          toolCalls,
          engine: "agent",
        };
      }
      const local = localMind({ text: input.text, lifeState: input.lifeState, sessionId: input.sessionId });
      return {
        text: local.text,
        cards: local.cards,
        outcome: local.outcome,
        toolCalls,
        engine: "local",
      };
    }

    /**
     * A truncated reply is reported rather than passed off as a short one.
     *
     * `finish_reason: "length"` means the model was still writing. When that
     * happens the text is whatever fitted, which reads as a complete thought and
     * is not one. Nothing can be done about it here - the answer is gone - but
     * it must be visible in the log, because the alternative is a bug report
     * about "she stopped mid-sentence" that nobody can reproduce.
     */
    if (completion.finishReason === "length") {
      console.warn(
        `[xana] reply truncated at maxTokens (round ${round}, ${completion.usage?.completionTokens ?? "?"} completion tokens, ${completion.usage?.reasoningTokens ?? 0} of them thinking)`,
      );
    }

    if (completion.text) text = stripMarkdown(completion.text);

    roundLog.push(
      `r${round}: finish=${completion.finishReason ?? "?"} tools=${completion.toolCalls.length} chars=${completion.text.length} out=${completion.usage?.completionTokens ?? "?"}(think ${completion.usage?.reasoningTokens ?? "?"})`,
    );

    if (completion.toolCalls.length === 0) {
      /**
       * ORDER MATTERS HERE, AND GETTING IT WRONG COST FOUR ROUNDS LIVE.
       *
       * The markup recovery runs FIRST. It has to: the full-width DSML form
       * contains a tool name, so an announcement check placed before it matches
       * `<||DSML|| invoke name="get_goals">` and politely asks the model to try
       * again - four times - instead of simply recovering the call that is
       * sitting right there in the text. The loop then reports no reply and the
       * user gets a refusal, having done nothing wrong.
       *
       * Recovery is the more specific test and the one that can *fix* the turn,
       * so it goes first. Only what recovery cannot parse is treated as an
       * announcement.
       */
      const recovered = recoverTextToolCalls(completion.text);
      if (recovered.calls.length > 0) {
        console.warn(`[xana] model wrote tool calls as text; recovered ${recovered.calls.map((c) => c.name).join(",")}`);
        text = stripMarkdown(recovered.cleaned);

        const synthesised: LlmToolCall[] = recovered.calls.map((call, index) => ({
          // A deterministic id, because the model supplied none and the id is
          // half of the idempotency key. Reusing `recover` plus the index means
          // a repeat of the same malformed output cannot double-write.
          id: `recover_${round}_${index}`,
          name: call.name,
          arguments: JSON.stringify(call.args),
        }));

        messages.push({ role: "assistant", content: completion.text, tool_calls: synthesised });
        for (const call of synthesised) {
          const record = applyToolCall(call, input, toolCalls);
          if (record.outcome?.ok) outcome = record.outcome;
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify(record.result),
          });
        }
        continue;
      }

      /**
       * An announced-but-unmade tool call forces another round.
       *
       * This is the variant with no markup to recover at all: the model told the
       * user what it was about to do and stopped. Accepting it would leave the
       * promise on screen and the question unanswered.
       */
      if (announcesToolUse(completion.text)) {
        console.warn(`[xana] model announced a tool call without making one; asking again: ${completion.text.trim().slice(0, 80)}`);
        text = "";
        messages.push({
          role: "user",
          content:
            "You said you were about to look something up but did not actually call the tool. Call it now, then answer me from what it returns.",
        });
        continue;
      }

      break;
    }

    // The assistant turn is recorded verbatim so the provider sees its own call
    // echoed back on the next request, which is what the wire format requires.
    //
    // `reasoning_content` is deliberately NOT echoed. The documentation says a
    // request carrying `tools` must replay it or receive a 400; a live probe on
    // 2026-10-08 shows that is false, and replaying a few hundred tokens of
    // chain-of-thought on every round of every turn would be pure input cost.
    messages.push({
      role: "assistant",
      content: completion.text,
      tool_calls: completion.toolCalls,
    });

    for (const call of completion.toolCalls) {
      const record = applyToolCall(call, input, toolCalls);
      if (record.outcome?.ok) outcome = record.outcome;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.name,
        content: JSON.stringify(record.result),
      });
    }
  }

  /**
   * The last word is the model's, unless the model had nothing to say.
   *
   * `localMind` is asked again rather than reusing the caller's earlier result,
   * because a write may have changed the life state and the honest sentence is
   * the one that reflects the list as it now stands.
   */
  /**
   * The last thing before the text leaves this module.
   *
   * Every reply the loop produced passes through here - the model's final
   * sentence, the fallback line, the conversation route. `stripToolMarkup` is
   * idempotent and cheap, and it is the guarantee that no user ever reads
   * `<|invoke name=...>` on their screen, whatever new spelling of it a provider
   * invents next week. The recovery above turns a *recognisable* call back into a
   * real one; this is what covers the shapes that are not recognisable.
   */
  text = stripToolMarkup(text);

  /* --- 3. Nothing usable came back. Say something true about why. --- */
  if (!text.trim()) {
    if (outcome?.ok) {
      text = outcome.message || fallbackLine(outcome);
    } else {
      /**
       * The loop ran and produced nothing a user could read.
       *
       * The local engine's sentence is what the user gets, and it is honest -
       * but which of the three causes it was is invisible from the chat window,
       * and they need different fixes:
       *
       *   - every round asked for a tool and never answered (raise the round cap,
       *     or tighten a tool description);
       *   - a reply was truncated to nothing (`finish_reason: "length"`, raise
       *     `maxTokens`);
       *   - the model genuinely said nothing (`finish_reason: "stop"`, empty
       *     content - a provider quirk with no fix on this side).
       *
       * So the reasons are collected and logged together, once, with the round
       * count. Without this the only evidence of a broken turn is a user saying
       * "she didn't answer", which is not reproducible.
       */
      console.warn(
        `[xana] agent loop produced no reply after ${rounds} round(s); rounds: ${roundLog.join(" | ") || "none"}`,
      );      const local = localMind({ text: input.text, lifeState: input.lifeState, sessionId: input.sessionId });
      text = local.text;
      return { text, cards: local.cards, outcome: outcome ?? local.outcome, toolCalls, engine: "local" };
    }
  }

  return { text, outcome, toolCalls, engine: "agent" };
}

/** A sentence for a write that succeeded but produced no message of its own. */
function fallbackLine(outcome: ActionOutcome): string {
  const n = outcome.ids?.length ?? 0;
  return n > 0 ? `Done - ${n} saved.` : "Done.";
}

/**
 * One tool call, from the wire to the database and back.
 *
 * Returns what the model should be told, plus the outcome when a real write
 * happened. Every refusal path returns a sentence rather than an exception, so
 * the model can correct itself in the next round and then explain honestly if it
 * cannot.
 */
function applyToolCall(
  call: LlmToolCall,
  input: AgentTurnInput,
  log: AgentToolCallRecord[],
): { result: Record<string, unknown>; outcome?: ActionOutcome } {
  const parsed = parseToolArguments(call.arguments);
  if (!parsed.ok) {
    log.push({ name: call.name, ok: false, reason: parsed.error });
    return { result: { ok: false, error: parsed.error } };
  }

  const proposal: Proposal = { tool: call.name, args: parsed.args };
  const verdict = validateActionIntent(proposal, {
    lifeState: input.lifeState,
    toolCallId: call.id,
  });

  if (verdict.verdict === "refuse") {
    log.push({ name: call.name, ok: false, reason: verdict.reason });
    return { result: { ok: false, error: verdict.reason } };
  }

  if (verdict.verdict === "confirm") {
    /**
     * The question is asked, and the model is told to ask it.
     *
     * The pending entry holds the *validated intent*, not the model's proposal,
     * so the "yes" that follows executes exactly what was approved. And the
     * result handed back to the model is explicitly "not done yet", because a
     * model told "ok" here would confirm the removal in its reply and the user
     * would believe a delete had happened when the app was still waiting for an
     * answer.
     */
    pending.set(input.sessionId, {
      intent: verdict.intent,
      tool: verdict.spec.name,
      question: verdict.question,
      askedAt: Date.now(),
    });
    log.push({ name: call.name, ok: false, reason: "awaiting confirmation" });
    return {
      result: {
        ok: false,
        pending_confirmation: true,
        not_done_yet: true,
        ask_the_user: verdict.question,
      },
    };
  }

  if (verdict.spec.safety === "read") {
    // A read tool carries its own payload; it never reaches executeAction.
    const read = verdict.spec.handler(parsed.args, { lifeState: input.lifeState, sessionId: input.sessionId });
    log.push({ name: call.name, ok: read.ok, effect: "read" });
    return { result: read.ok ? { ok: true, data: read.data } : { ok: false, error: read.error } };
  }

  const executed = executeProposal(verdict.intent, verdict.spec.name, input.sessionId, call.id);
  log.push({ name: call.name, ok: executed.ok, effect: executed.effect });
  return {
    result: {
      ok: executed.ok,
      effect: executed.effect,
      ...(executed.message ? { said: executed.message } : {}),
    },
    outcome: executed,
  };
}

/* ------------------------------------------------------------------ */
/* Announcements that are not calls                                    */
/* ------------------------------------------------------------------ */

/**
 * A reply that names a tool instead of calling it.
 *
 * FOUR VARIANTS OF ONE FAILURE, ALL OBSERVED LIVE
 *
 * Every one of these reached the user, on a real turn, with a real key:
 *
 *     <||DSML||invoke name="get_goals">     markup, recoverable
 *     <tool_call>get_goals</tool_call>      markup, recoverable
 *     (calling get_goals)                   prose
 *     Calling: get_goals                    prose
 *
 * The first two are handled by `recoverTextToolCalls`. This function exists for
 * the last two, and the first version of it was written as a list of phrasings -
 * which matched "(calling get_goals)" and missed "Calling: get_goals" on the very
 * next run. A pattern list is the wrong shape for this: the model is not
 * speaking a fixed vocabulary, it is describing an action in prose, and there is
 * no end to the ways it can do that.
 *
 * So the test is grounded in the thing that does not vary - **the catalog**. If
 * a short reply names one of her own tools, has no sentence-ending punctuation
 * and no digits, then it is telling the user what it is about to do rather than
 * doing it. The three constraints are what keep it off ordinary answers:
 *
 *   - a tool name has to appear at all ("You have two things open" has none);
 *   - a real answer almost always ends with a full stop, and an announcement
 *     almost never does ("Calling: get_goals", "(looking up your tasks)");
 *   - real answers carry specifics - times, dates, counts - and an announcement
 *     carries none.
 *
 * The cost of a false positive is one wasted round trip; the cost of a false
 * negative is the user reading a promise the app never kept. So it errs toward
 * continuing, and whatever comes back is still checked again on the next round.
 */
export function announcesToolUse(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 120) return false;
  if (!ALL_TOOLS.some((tool) => t.includes(tool.name))) return false;
  // A finished answer: a sentence ending, or a number the user would want.
  if (/[.!?]\s*$/.test(t)) return false;
  if (/\d/.test(t)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* The conversational route                                            */
/* ------------------------------------------------------------------ */

/**
 * A turn that is talk rather than a request, answered with no tools at all.
 *
 * This is the half of the user's complaint that had nothing to do with
 * capability. Before this route existed, "I'm not sure I want the new job" fell
 * through the entire local engine and came back as *"I didn't follow that. I'm
 * better with concrete things."* No model was ever asked, even with a key
 * configured, because the only path to the model ran through an action.
 *
 * Tools are omitted rather than offered-and-ignored: a model handed a tool
 * catalog while someone is telling it about their week will eventually find a
 * reason to use one, and turning a feeling into a task list is the exact failure
 * the persona warns against. The situation is named in the prompt for the mirror
 * reason - a model given only a life state defaults to summarising it, which is
 * the "wall of status" that makes an assistant feel like a dashboard.
 */
export async function runConversationTurn(input: {
  text: string;
  lifeState: LifeState;
  sessionId: string;
  modality?: "text" | "voice";
}): Promise<AgentTurnResult | undefined> {
  if (!llmAvailable()) return undefined;

  const settings = loadSettings();
  const today = new Date();

  try {
    const completion = await llmComplete(
      [
        {
          role: "system",
          content: conversationalSystemPrompt({
            userName: settings.identity.name,
            location: settings.identity.location,
            today: today.toLocaleDateString(undefined, {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
            partOfDay: input.lifeState.partOfDay,
          }),
        },
        {
          role: "user",
          content: `LIFE STATE (background - do not summarise it)\n${renderLifeState(input.lifeState)}\n\nTHEY SAID: ${input.text}`,
        },
      ],
      { maxTokens: 700, thinking: true },
    );

    const text = shapeForModality(stripMarkdown(completion.text), input.modality);
    if (!text.trim()) return undefined;
    return { text, toolCalls: [], engine: "agent" };
  } catch {
    return undefined;
  }
}

/** Wall-clock marker for a turn, exposed so a caller can report latency. */
export function turnStamp(): string {
  return nowIso();
}
