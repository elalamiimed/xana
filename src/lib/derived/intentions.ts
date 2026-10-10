/**
 * Implementation intentions: the if/then half of a goal.
 *
 * WHY THIS IS A SEPARATE THING FROM A MILESTONE
 *
 * A milestone says *what* will be true and by when. It says nothing about when
 * or where the work happens, and that is the gap where goals die: "run a half
 * marathon" and "run 10km by March" are both perfectly clear, and neither tells
 * you what to do on a wet Tuesday.
 *
 * An implementation intention names the cue instead of the outcome - "if it is
 * Tuesday at 7am, then I run with the group" - and the cue is what does the
 * work, because it hands the decision to the situation rather than to
 * willpower. The measured effect is among the larger ones in the behaviour
 * literature, though the commonly quoted figure (about d = 0.65) comes from a
 * secondary summary rather than a source read directly, so it is recorded here
 * as an indication and not as a number to show a user.
 *
 * THE SHAPE IS DELIBERATELY DUMB
 *
 * Two strings: a trigger and an action. No recurrence rule, no calendar
 * semantics, no scheduling engine. The value is in having written the sentence
 * down and having Xana able to say it back at the right moment - which
 * `derived/proactive.ts` does. A richer model would be a richer thing to get
 * wrong, and nothing here needs it.
 */

import type { XanaStore } from "../core/store";
import { getStore } from "../core/store";

export interface Intention {
  id: string;
  goalId: string;
  /** The cue: "it is Tuesday morning", "I sit down at the desk". */
  trigger: string;
  /** What happens then. */
  action: string;
  createdAt: string;
}

/** The intention attached to a goal, if there is one. One per goal, on purpose. */
export function intentionFor(goalId: string, store: XanaStore = getStore()): Intention | undefined {
  return store.listIntentions(goalId)[0];
}

/** Every intention, for the pass that decides when to mention one. */
export function allIntentions(store: XanaStore = getStore()): Intention[] {
  return store.listIntentions();
}

/**
 * Write an intention from something the user said.
 *
 * The "if" and the "then" are usually both in the sentence - "when I get in on
 * Tuesdays I'll run" - so they are split rather than invented. A sentence with
 * only one half returns undefined: a trigger with no action, or an action with
 * no trigger, is not an implementation intention, and storing half of one would
 * put a sentence in front of the user at a moment that means nothing.
 */
export function parseIntention(
  text: string,
): { trigger: string; action: string } | undefined {
  const cleaned = text.trim().replace(/[.!]+$/, "");
  const patterns: RegExp[] = [
    /^(?:if|when|whenever)\s+(.+?)[,;]?\s+(?:then\s+)?i(?:'ll| will| am going to| wanna| want to| shall)\s+(.+)$/i,
    /^(?:if|when|whenever)\s+(.+?)[,;]\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const m = pattern.exec(cleaned);
    if (!m) continue;
    const trigger = m[1].trim();
    const action = m[2].trim().replace(/^i(?:'ll| will)\s+/i, "");
    if (trigger.length < 3 || action.length < 3) continue;
    return { trigger, action };
  }
  return undefined;
}

/**
 * A sentence for the moment the trigger comes up.
 *
 * Written as a reminder rather than an instruction, and it does not say "you
 * should". The point of having written the intention down is that the decision
 * is already made; a sentence that reopens it is worse than silence.
 */
export function intentionSentence(intention: Intention, goalTitle: string): string {
  return `If ${lowerFirst(intention.trigger)}, then ${lowerFirst(intention.action)} - the ${goalTitle} plan.`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
