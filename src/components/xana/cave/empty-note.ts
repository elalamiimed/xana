/**
 * What a room says when it has nothing to show — and what it says while it
 * does not know yet.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * "Nothing open" is a claim about what is in the database, and a list that
 * has not been read cannot support it. Every room had one of these sentences
 * hardcoded, so a slow or failed first read looked exactly like an empty
 * life: a board holding three goals said "Nothing on the board yet" and the
 * front page beside it said otherwise.
 *
 * One string, in one place, because the cave has five rooms and the day they
 * disagree about whether they are loading or empty is the day this bug comes
 * back somewhere nobody is looking. It is separate from `useCave` so that a
 * Node check can import it — and hold the rooms to it — without dragging
 * React along for two lines.
 */

/** The line every room shows until its first read has answered. */
export const READING = "Reading…";

/**
 * The empty state, or the truth that there is not one yet.
 *
 * A request that never returns therefore stays visibly unfinished rather
 * than quietly reassuring.
 */
export function emptyNote(loading: boolean, empty: string): string {
  return loading ? READING : empty;
}
