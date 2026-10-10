/**
 * What she may say she did.
 *
 * THE FAILURE THIS EXISTS FOR
 *
 * A session where the user described a 2pm meeting, then asked for the garbled
 * task that held it to be retitled. There was no path in the app that could
 * rename a task, so no action ran — and the reply said:
 *
 *     Done. The task is now titled "2pm Budget review."
 *
 * Nothing had changed. The user found out by looking at the list and said the
 * title was still wrong.
 *
 * The structural rule at the top of `mind/index.ts` says intent resolution is
 * local, always, so the model can never *do* something that does not get
 * written the same way every time. That rule governs what she does. This module
 * governs what she *says she did*, which is the half that was missing: a false
 * completion claim is worse than a refusal, because the user only discovers it
 * by checking, and the whole point of the thing is that they do not have to.
 *
 * TWO HALVES, AND WHY BOTH ARE NEEDED
 *
 *   `actionRule`        — the instruction the model reads before it speaks. It
 *                         is the cheap half and it is advice.
 *   `guardUnmadeClaim`  — the check afterwards, which does not depend on the
 *                         model's cooperation, because advice is not a mechanism.
 *
 * Pure, and separate from the model call, so `scripts/check-edit-voice.ts` can
 * drive the exact sentence that produced the lie without a network or a key.
 */

/** What the user is left with when a reply had to be replaced. It has to be
 *  true as well as honest, so it names a wording that does work. */
export const NOTHING_CHANGED =
  "Nothing changed — I did not do that, and I will not say I did. If it was a task, try \"rename <the task> to <new name>\" and I can; anything in My cave can be edited by hand.";

/**
 * The rule, as the model reads it.
 *
 * Two versions rather than one, because the honest sentence depends on whether
 * the local mind acted: with an outcome, the model is told to describe it and
 * nothing more; without one, it is told that nothing happened at all.
 */
export function actionRule(acted: boolean): string {
  return acted
    ? "ACTION RESULT above is everything that happened this turn. Describe it and nothing more; never claim a change that is not in it."
    : "NOTHING WAS DONE THIS TURN. No action ran, and you cannot perform actions yourself: the ACTION RESULT block is the only evidence that anything happened. Never say or imply that you added, created, renamed, changed, updated, moved, rescheduled, completed, saved or deleted anything, and never agree that something is done. If the user asked for a change, say plainly that it did not happen, and give them a wording that does work.";
}

/**
 * A reply that denies an action which DID run.
 *
 * The guard below catches a model claiming a change that never happened. This
 * catches the mirror image, and it is not hypothetical: the user asked for three
 * calendar entries, one was created with the whole line as its title, and the
 * reply said *"That one landed wrong. The parser read your whole line as a
 * single event title … and booked it as one block. It's not three entries."* —
 * an announcement of failure about a turn that had reached the database, with an
 * explanation of *why* that the model could not possibly have known.
 *
 * A model can only ever see the ACTION RESULT it is given, so a claim about the
 * mechanism of a failure is always a guess. The rule here is therefore narrow in
 * one direction only: when an action ran and the reply says nothing happened,
 * the false part is replaced with what actually happened.
 *
 * The alternatives are the phrasings a model reaches for, written from real
 * replies rather than invented. The first version had `your line was read as`,
 * which missed the real sentence because "The parser" sits between *read* and
 * *your* — the check was written from the reply and still managed to paraphrase
 * it. Each pattern is deliberately loose about the words in the middle and tight
 * about the shape at the ends.
 */
const DENIES_AN_ACTION: RegExp[] = [
  // "nothing was added", "no events were created", "nothing got saved"
  /\b(?:nothing|no(?:thing)?)\s+(?:was|has been|had been|got|were)\s+(?:added|created|booked|saved|changed|updated|moved|deleted|removed|done)\b/i,
  // "no events were created", "no entries were saved"
  /\bno\s+(?:events?|entries|tasks?|items?)\s+(?:were|was|got)\s+(?:created|added|booked|saved)/i,
  // "that didn't go through", "it did not work", "that didn't save"
  /\b(?:did(?:n't| not)\s+(?:go through|work|save|register))\b/i,
  // "landed wrong", "went wrong", "that one came through wrong"
  /\b(?:landed|came through|went)\s+wrong\b/i,
  // "the parser read your whole line as a single event" — loose in the middle
  /\bread\s+your\s+(?:whole\s+)?(?:line|sentence|message)\s+as\b/i,
  // "booked it as one block", "saved as a single entry"
  /\b(?:booked|saved|created|stored)\s+it\s+as\s+(?:one|a single)\b/i,
  // "it's not three entries", "that is not 3 events"
  /\b(?:it'?s|that'?s|this is)\s+not\s+(?:one|two|three|four|\d+)\s+(?:entr|event|task|item)/i,
];

export function deniesAnActionThatRan(reply: string): boolean {
  return DENIES_AN_ACTION.some((test) => test.test(reply));
}

/**
 * The check: three conditions together, each one narrow on purpose.
 *
 *   1. no action ran this turn, and
 *   2. the user's turn was a request to change something, and
 *   3. the reply claims the change in the first person.
 *
 * A reply that merely discusses a change — "nothing is scheduled at two", "you
 * added that yesterday" — matches none of the three and passes through
 * untouched.
 */
export function guardUnmadeClaim(
  reply: string,
  input: { text: string; acted: boolean },
): { text: string; replaced: boolean } {
  if (input.acted) return { text: reply, replaced: false };
  if (!looksLikeChangeRequest(input.text)) return { text: reply, replaced: false };
  if (!claimsAChange(reply)) return { text: reply, replaced: false };
  return { text: NOTHING_CHANGED, replaced: true };
}

export function looksLikeChangeRequest(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/^(?:xana|hey xana)[,\s]+/, "")
    .replace(/^(?:please|can you|could you|would you|i want you to|i'?d like you to)\s+/, "");

  // A confirmation of an offer. "Yes, please." is what cost the user a false
  // "Done.", and it is a change request in every way that matters here.
  if (/^(?:yes|yeah|yep|ok|okay|sure|go ahead|do it|please do|that one)\b/.test(t)) return true;

  return /^(?:add|create|make|rename|retitle|re-title|call|change|update|set|move|push|reschedule|delete|remove|drop|cancel|forget|complete|finish|mark|clear|schedule|book|save|edit|remind)\b/.test(
    t,
  );
}

/**
 * A first-person claim that something was done.
 *
 * Deliberately not a search for the word "done": "your afternoon is done" is
 * describing a day, and "I've renamed it" is claiming an action. Only the second
 * is a lie when nothing ran.
 */
export function claimsAChange(reply: string): boolean {
  const t = reply.trim();
  if (/^done[.!]?$/i.test(t)) return true;
  return /\b(?:i(?:'ve| have)\s+(?:now\s+|just\s+)?(?:renamed|retitled|re-?titled|updated|changed|added|created|deleted|removed|saved|set|moved|rescheduled|marked|completed|scheduled|booked|cleared|fixed)|i\s+(?:renamed|retitled|updated|changed|added|created|deleted|removed|saved|moved|rescheduled|marked|completed|scheduled|booked|cleared)\b|it(?:'s| is) (?:now |been )?(?:renamed|retitled|updated|changed|added|deleted|removed|saved|moved|rescheduled|completed|cleared)|(?:the\s+)?(?:task|event|goal|memory|reminder|meeting)\s+is\s+now\s+(?:titled|named|called|set|scheduled)|has been (?:renamed|retitled|updated|changed|added|deleted|removed|moved|rescheduled|completed|cleared))\b/i.test(
    t,
  );
}
