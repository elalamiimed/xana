/**
 * Is this talk, or is this a request?
 *
 * WHY THE DISTINCTION MATTERS MORE THAN IT LOOKS
 *
 * Before this existed, every turn that the local intent engine did not resolve
 * got the same sentence: "I didn't follow that. I'm better with concrete things."
 * Even with a model configured, there was no path that let it answer a question
 * about the user's week, because the only route to the model ran through an
 * action. That is the mechanical cause of "she can't really hold a conversation".
 *
 * So an unmatched turn now has two ways to go, and this function picks:
 *
 *   casual   -> the model answers as conversation, with NO tools offered
 *   request  -> the agent loop runs, with the tool catalog
 *
 * TWO WAYS TO GET THIS WRONG, AND ONLY ONE IS DANGEROUS
 *
 * Calling a *request* casual means a real change silently does not happen: the
 * user asked for a task and got a sympathetic paragraph, and they only find out
 * by checking the list. That is the same class of failure as a model claiming
 * "Done." when nothing ran, and it is worse than a refusal.
 *
 * Calling *talk* a request means the agent loop runs, the model has the tool
 * catalog in front of it, and it decides. That is not dangerous - the guard and
 * the executor are still the only path to a write - it just costs a round trip.
 *
 * So the bias here is deliberate and one-directional: **when in doubt, it is a
 * request.** The rules below are written to catch talk only when it is clearly
 * talk, and the change-request vocabulary is checked first, unconditionally.
 */

import { PERSONA_CORE, PERSONA_GUIDELINES } from "./persona";

/**
 * The opening vocabulary of a request to change something.
 *
 * Shared in spirit with `looksLikeChangeRequest` in `./claims`, which decides
 * whether a reply may be checked for an unmade claim. The two are separate
 * because they answer different questions - that one asks "could the user have
 * been expecting a change", this one asks "should tools be offered at all" - and
 * because merging them would make a change to either one silently alter the
 * other's behaviour.
 */
const REQUEST_OPENER =
  /^(?:please\s+|can you\s+|could you\s+|would you\s+|i want you to\s+|i'?d like you to\s+)?(?:add|create|make|rename|retitle|re-?title|call|change|update|set|move|push|reschedule|delete|remove|drop|cancel|forget|complete|finish|mark|clear|schedule|book|save|edit|remind|log|note|record|start|protect|block|pin|unpin|tick|check)\b/i;

/** A bare yes or no is always an answer to something, never conversation. */
const CONFIRMATION = /^(?:yes|yeah|yep|yup|ok|okay|sure|no|nope|nah|do it|go ahead|please do|confirm|confirmed|cancel|never ?mind|that'?s? right|correct)\b[\s.!]*$/i;

/** Questions that are requests for her to *do* something with the data. */
const REQUEST_QUESTION =
  /\b(?:what(?:'s| is| are| did| does| should)|how (?:are|is|did|does)|when (?:is|are|did)|show me|list|tell me (?:what|when|how)|brief me|remind me)\b/i;

/**
 * Phrases that are unmistakably conversation.
 *
 * Possessive and first-person reflection: someone talking about how they feel,
 * what they are weighing, or what they noticed. These do not survive being
 * phrased as an instruction, which is what makes them safe to match.
 */
const TALK_MARKERS = [
  /\b(?:i'?ve been|i have been|i'?m|i am|i feel|i felt|i think|i thought|i wonder|i'?m not sure|i don'?t know)\b/i,
  /\b(?:honestly|to be honest|frankly|between us|weirdly|anyway)\b/i,
  /\b(?:how (?:was|are) (?:your|you))\b/i,
  /\b(?:do you (?:ever|think|feel|get|like|remember))\b/i,
  /\b(?:what do you (?:think|reckon|make))\b/i,
  /\b(?:tell me something|say something|talk to me|keep me company)\b/i,
  /\b(?:i keep|i can'?t stop|it'?s been a|it has been a)\b/i,
];

/**
 * True when the utterance should be answered as conversation.
 *
 * Order is the whole design: a request opener wins outright, then a bare
 * confirmation, then a request-shaped question, and only then is talk
 * considered. That ordering is what makes the doubt resolve toward "request".
 */
export function isCasual(text: string): boolean {
  const t = text
    .trim()
    .replace(/^(?:hey|hi|hello|yo|ok|okay)?[,\s]*(?:xana)[,\s]+/i, "")
    .trim();

  if (t.length === 0) return false;

  // A request to change something is never conversation, whatever else it says.
  if (REQUEST_OPENER.test(t)) return false;
  if (CONFIRMATION.test(t)) return false;
  if (REQUEST_QUESTION.test(t)) return false;

  /**
   * A question mark is not enough on its own.
   *
   * "Can you add milk?" is a request and is already caught above. What reaches
   * here with a question mark is something like "why do I always leave this to
   * the last minute?" - which is talk - or "what is the capital of Peru?", which
   * is a real question of fact and equally conversation, since no tool in the
   * catalog answers it. Both are better served by the conversational route, so a
   * question mark is treated as talk once the request shapes are excluded.
   */
  if (/\?\s*$/.test(t)) return true;

  // A short imperative-looking fragment with no talk marker is more likely a
  // terse request than conversation, so it falls through to the agent loop.
  return TALK_MARKERS.some((pattern) => pattern.test(t));
}

/**
 * The system prompt for a conversational turn.
 *
 * Two differences from the agent prompt, and both are the point:
 *
 *   1. **No tool catalog.** Offering tools to a model while someone is telling
 *      it about their week invites it to find a use for one, and turning a
 *      feeling into a task list is the exact behaviour the persona warns about.
 *   2. **The situation is named.** A model given only the life state will
 *      default to summarising it, which is the "wall of status" failure. Telling
 *      it outright that this is a conversation and that the state is background
 *      is what makes it answer the person rather than the data.
 */
export function conversationalSystemPrompt(o: {
  userName?: string;
  location?: string;
  today: string;
  partOfDay: string;
}): string {
  const parts = [PERSONA_CORE, PERSONA_GUIDELINES];

  const name = (o.userName ?? "").trim();
  if (name) parts.push(`You are speaking with ${name}. Use their name sparingly - once is usually enough.`);
  const location = (o.location ?? "").trim();
  if (location) parts.push(`They are in ${location}.`);

  parts.push(`Today is ${o.today}. It is ${o.partOfDay}.`);

  parts.push(`THIS TURN
They are talking to you, not filing a request. There is nothing to schedule, capture or log unless they say so in as many words.
- Answer what they actually said. If they are thinking out loud, think with them rather than resolving it into a plan.
- Do not open with a summary of their day, their calendar or their task list. The LIFE STATE below is background you may draw on when it is genuinely relevant - once, briefly - not the subject of the reply.
- One or two short sentences is usually the whole answer. Match their length: a one-line message does not deserve a paragraph.
- Have a view. If they ask what you think, tell them, and give the reason in the same breath.
- It is fine to ask one question back when you actually want to know. It is not fine to end every reply with one.`);

  return parts.join("\n\n");
}
