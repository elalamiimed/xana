/**
 * How she sounds, as functions rather than as advice in a prompt.
 *
 * EVERYTHING HERE IS PURE
 *
 * No I/O, no settings read, no model call. That is not tidiness: these are the
 * rules applied to *every* reply after it comes back from a model, so they have
 * to be testable without a network, and a rule that can silently fail to load is
 * a rule that is not applied. `scripts/check-persona.ts` drives this file
 * directly.
 */

/**
 * Strip markdown, because the interface renders plain text.
 *
 * Moved here from `mind/index.ts`, where it lived as a private function. It
 * moved for one reason: the agent loop needs it too, and a second copy would
 * drift. A model asked for a short answer in a chat window reaches for `**` and
 * `-` regardless of what the persona says, and those characters arrive on screen
 * as literal noise, so this is not cosmetic - it is the difference between a
 * reply that reads as written and one that reads as broken.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1$2")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/**
 * Trim a reply for the ear, without cutting a word in half.
 *
 * Voice has a hard constraint text does not: the listener cannot skim, re-read,
 * or see where a sentence was going. A reply that is fine on screen is
 * exhausting read aloud, so this shortens to whole sentences and then to whole
 * words, and it never returns a fragment ending mid-word.
 *
 * It is deliberately conservative about *when* it shortens. Only a reply that is
 * genuinely too long for speech is touched; anything shorter is returned
 * unchanged, because a shaping function that rewrites good replies is a function
 * that eventually rewrites a correct one into a wrong one.
 */
export function shapeForModality(text: string, modality?: "text" | "voice"): string {
  const clean = text.trim();
  if (modality !== "voice") return clean;
  if (clean.length <= VOICE_BUDGET) return clean;

  /**
   * Cut at the last sentence boundary inside the budget.
   *
   * `[.!?]` followed by whitespace or the end, so a decimal or an abbreviation
   * in the middle of a word does not count as an ending. If no boundary exists
   * in range, fall back to a word boundary - a long single sentence still has to
   * fit in a listener's attention.
   */
  const window = clean.slice(0, VOICE_BUDGET);
  const sentenceEnd = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  if (sentenceEnd > VOICE_BUDGET * 0.4) return clean.slice(0, sentenceEnd + 1).trim();

  const wordEnd = window.lastIndexOf(" ");
  if (wordEnd > 0) return `${clean.slice(0, wordEnd).trim()}`;
  return window.trim();
}

/**
 * The budget for a spoken reply, in characters.
 *
 * About thirty words. Short enough to finish before the listener starts
 * composing their answer, which is the real limit on spoken prose - not
 * intelligibility. The persona asks the model for the same thing; this is the
 * mechanism for when the model does not comply.
 */
export const VOICE_BUDGET = 180;

/**
 * Does this reply flatter instead of inform?
 *
 * THE FAILURE THIS CATCHES
 *
 * Sycophancy - agreeing rather than being useful - is the documented failure
 * mode that makes an assistant feel *less* capable, and it is the specific risk
 * of adding warmth to a persona. The research pass found it is measurable and
 * that it is reinforced by training on what users liked hearing, which is why
 * Xana's memory write path refuses to store praise (see `derived/memory.ts`).
 * This is the same rule applied to what she *says*.
 *
 * It is a detector, not a filter: nothing deletes a sentence because it matched.
 * The value is in the test suite and in making the rule concrete, so a persona
 * edit that starts producing "What a brilliant idea!" fails a check rather than
 * quietly changing how she feels to talk to.
 *
 * FALSE POSITIVES ARE THE DANGER. "Good call - the earlier slot is clearer" is
 * warm *and* substantive, and must not match. So every pattern requires praise
 * with no information attached: a bare compliment, an affirmation of the user's
 * judgement, or enthusiasm about the question rather than the answer.
 */
const SYCOPHANCY: RegExp[] = [
  // "What a great idea!", "That's a brilliant plan", "what a fantastic question"
  /\bwhat an? (?:great|brilliant|fantastic|amazing|excellent|wonderful|interesting) \w+/i,
  /*
   * "That's a brilliant plan", "this is a great idea".
   *
   * The second shape, and it was missing: the first version of this list
   * required the praise to be wrapped in "what a", so the most ordinary way
   * anyone writes it - "That's a brilliant plan." - passed straight through and
   * the suite caught the gap. It is a predicate compliment: a demonstrative,
   * a copula, an admiring adjective, and the user's own noun.
   *
   * Deliberately narrower than a bare adjective search. "The plan is clear" and
   * "that's the right call, given the deadline" are judgements with a reason,
   * which is what she is supposed to do; only the *unqualified* compliment is
   * flattery, so the adjective list stays short and no clause may follow.
   */
  /\b(?:that|this|it)(?:'s| is| was)\s+(?:a\s+|an\s+|really\s+|such\s+a\s+)*(?:brilliant|fantastic|amazing|wonderful|excellent|genius|superb)\b/i,
  // "You're absolutely right", "you are so right", "you're right about that"
  /\byou(?:'re| are)\s+(?:absolutely |totally |completely |so )?right\b/i,
  // "That's a great question", "good question!"
  /\b(?:great|good|excellent|fantastic|brilliant) question\b/i,
  // "I love that idea", "I love this plan"
  /\bi (?:love|adore) (?:that|this|it)\b/i,
  // "What a wonderful way to think about it"
  /\bwhat a (?:lovely|wonderful|refreshing) way\b/i,
  // "You're doing amazing", "you've got this", bare encouragement
  /\byou(?:'ve| have) got this\b/i,
  /\byou(?:'re| are) doing (?:amazing|great|fantastic)\b/i,
  // "That sounds like a really solid approach" - praise with no fact in it
  /\bthat sounds (?:like )?(?:a )?(?:really |very |quite )?(?:solid|great|excellent|good) (?:approach|plan|idea)\b/i,
  // "Absolutely!", "Exactly!" as an entire reply
  /^(?:absolutely|exactly|totally|precisely|100%)[.!]?$/i,
];

export function soundsSycophantic(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  return SYCOPHANCY.some((pattern) => pattern.test(t));
}

/** Every sycophantic phrasing, for the suite to assert against. */
export const SYCOPHANCY_PATTERNS: readonly RegExp[] = SYCOPHANCY;
