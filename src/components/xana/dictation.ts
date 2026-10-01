/**
 * Turning a stream of recognition events into one stable transcript.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * The obvious implementation is one line — read every result in the event and
 * use that as the text — and it is wrong in a way that destroys the user's words
 * instead of merely repeating them. `event.results` is the result list for the
 * CURRENT recogniser session, and sessions do not survive a pause: the browser
 * ends one after a few seconds of silence, `onend` restarts it, and the new
 * session's list starts empty. Rebuilding the field from that list therefore
 * drops everything said before the pause. From the user's side that is not "it
 * misheard me", it is "it deleted what I said", which is the worst thing
 * dictation can do.
 *
 * It is also not testable inside a component: reproducing it needs a browser
 * that ends a session mid-sentence, which is exactly what cannot be arranged on
 * demand. So the accumulation is a pure function of (previous state, event) and
 * lives here, where `scripts/check-dictation.ts` drives it through a session
 * boundary, an interim-to-final promotion, and a duplicated final — none of
 * which needs a microphone.
 *
 * THE TWO HALVES
 *
 *   committed — every FINAL result seen so far, across every session. Only ever
 *               grows. A final result is the recogniser's settled opinion and is
 *               never revised.
 *   interim   — the still-changing tail. REPLACED, never appended, because the
 *               recogniser re-sends a better guess at the same words each time.
 *               Appending it is what produces "hello hello hello".
 *
 * The field shows committed + interim, so words appear as they are heard and
 * firm up in place rather than jumping.
 */

/** The minimum surface of a recognition event this needs. */
export interface DictationEvent {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: {
      readonly isFinal: boolean;
      readonly [index: number]: { readonly transcript: string } | undefined;
    } | undefined;
  };
}

export interface DictationState {
  readonly committed: string;
  readonly interim: string;
  /**
   * How many results of the current session have been committed.
   *
   * This is the invariant the tail is rebuilt from. Within one session the
   * result list is append-only and immutable where it is final: index `i` means
   * the same words in every event that carries it. So everything at or after
   * `committedCount` is still unsettled, and the tail is the concatenation of
   * exactly those entries — rebuilt from the list each time rather than appended
   * to.
   *
   * Appending instead is what produces "remindremind me": the recogniser revises
   * a partial result at the SAME index, and an implementation that adds each
   * one accumulates every draft of the same words.
   */
  readonly committedCount: number;
  /**
   * The last final result committed, so a browser that re-sends one cannot
   * write it twice.
   *
   * Chromium has been observed repeating a final result on the event that also
   * carries the next interim. Without this guard the sentence gains a duplicate
   * word each time it happens, which reads as the app being broken rather than
   * as the browser being noisy.
   */
  readonly lastFinal: string;
}

export const EMPTY_DICTATION: DictationState = {
  committed: "",
  interim: "",
  committedCount: 0,
  lastFinal: "",
};

/**
 * The text to show: the settled transcript followed by the live tail.
 *
 * Joined with exactly one space when both halves exist. `committed` is stored
 * trimmed, so a plain template literal would run the halves together —
 * "helloworld" — while trimming only the outside would leave a double space
 * inside ("hello world  and"). Neither is visible until it reaches the user.
 */
export function dictationText(state: DictationState): string {
  const committed = state.committed.trim();
  const interim = state.interim.trim();
  if (!committed) return interim;
  if (!interim) return committed;
  return `${committed} ${interim}`;
}

/**
 * Fold one event into the running transcript.
 *
 * `resultIndex` is where to start reading, and honouring it is half the fix: a
 * browser re-sends the whole list on every event, so re-reading from zero would
 * commit every final result again on each pass and multiply the sentence.
 *
 * `newSession` is the other half, and it is passed in rather than inferred.
 * An earlier version tried to detect the boundary from `resultIndex === 0`, and
 * that is ambiguous: a session whose first result is also its last fires
 * `resultIndex: 0` too, so a genuine new session was indistinguishable from a
 * repeat and the live tail was wiped on ordinary events. The boundary is a fact
 * the caller knows exactly — it happens in `onend`, when the recogniser stops —
 * so it is told to this function instead of guessed at.
 *
 * A new session clears the tail (the old one is gone with its recogniser) and
 * the duplicate guard (a new recogniser may legitimately produce the same
 * words), and crucially does NOT touch `committed`. That is the whole point: the
 * words said before the pause outlive the session that heard them.
 */
export function accumulate(
  state: DictationState,
  event: DictationEvent,
  newSession = false,
): DictationState {
  let committed = state.committed;
  let committedCount = newSession ? 0 : state.committedCount;
  let lastFinal = newSession ? "" : state.lastFinal;

  // Commit every final result that has not been committed yet, in order. A
  // result at an index below the count was already folded in on an earlier
  // event; that is what `resultIndex` and the count are for, and skipping them
  // is what stops the sentence being written twice.
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    if (!result?.isFinal) continue;
    if (index < committedCount) continue;
    const trimmed = (result[0]?.transcript ?? "").trim();
    // The count advances even for a duplicate, because the index IS accounted
    // for; only the text is skipped.
    committedCount = index + 1;
    if (!trimmed || trimmed === lastFinal) continue;
    // A space between chunks: a final result often arrives without its leading
    // space, and "hello world" would otherwise become "hello worldand then".
    committed = committed ? `${committed} ${trimmed}` : trimmed;
    lastFinal = trimmed;
  }

  // Everything from the committed boundary onwards is still being revised, so
  // the tail is REBUILT from those entries. See `committedCount`.
  //
  // Each piece is trimmed and rejoined with one space: a browser is inconsistent
  // about leading and trailing spaces on a partial result, so concatenating them
  // raw produces "hello world  and" often enough to be noticed.
  const tail = interimParts(event, committedCount);
  const interim = tail.join(" ");

  return { committed, interim, committedCount, lastFinal };
}

/** The still-unsettled results, in order, trimmed, with the blanks dropped. */
function interimParts(event: DictationEvent, from: number): string[] {
  const parts: string[] = [];
  for (let index = from; index < event.results.length; index += 1) {
    const result = event.results[index];
    if (result?.isFinal) continue;
    const text = (result?.[0]?.transcript ?? "").trim();
    if (text) parts.push(text);
  }
  return parts;
}
