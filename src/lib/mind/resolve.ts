/**
 * Name resolution for tool arguments.
 *
 * THE RULE THIS EXISTS FOR
 *
 * **The model passes a name, never an id.** A tool called `complete_task` takes
 * `{"task": "review the Aurora deck"}`, not a uuid. Resolution happens here,
 * against the same `LifeState` the interface is rendering, for one reason: a
 * model that can supply an id can supply a *wrong* id, and a wrong id is a
 * silent edit to somebody else's record. A name that does not match is a
 * refusal, which the user can see and correct. An id that does not match is a
 * no-op, and one that matches the wrong row is a bug nobody notices until the
 * wrong task is closed.
 *
 * The matcher is deliberately the same shape as `bestMatch` in `./local`, which
 * already resolves "the dentist thing" for the removal handler. Two resolvers
 * that disagree would mean the same phrase removes one task and completes
 * another, so the scoring here is that function's, moved somewhere both callers
 * can reach.
 */

import type { LifeState } from "../core/types";

export interface Named {
  id: string;
  title: string;
}

export interface Resolved<T> {
  id: string;
  title: string;
  /** 0..1. Below the caller's floor this is not a match, it is a coincidence. */
  score: number;
  item: T;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * How well `phrase` names `title`, in [0, 1].
 *
 * Three channels, most confident first: an exact match after normalisation, a
 * substring either way, then token overlap. Overlap is measured against the
 * *phrase's* tokens rather than the union, because the phrase is what the user
 * said and the title is usually longer: "review the deck" naming "Review the
 * Aurora deck" shares two of three phrase tokens and should score well, while
 * matching only "the" should not.
 */
export function nameScore(phrase: string, title: string): number {
  const p = phrase.trim().toLowerCase();
  const t = title.trim().toLowerCase();
  if (!p || !t) return 0;
  if (p === t) return 1;

  const pFlat = p.replace(/[^a-z0-9]/g, "");
  const tFlat = t.replace(/[^a-z0-9]/g, "");
  if (pFlat.length >= 3 && tFlat.includes(pFlat)) return 0.9;

  const pt = tokens(p);
  const tt = new Set(tokens(t));
  if (pt.length === 0 || tt.size === 0) return 0;
  let shared = 0;
  for (const w of pt) if (tt.has(w)) shared++;
  return shared / pt.length;
}

/**
 * The best match at or above `floor`, or `undefined`.
 *
 * A floor is required rather than defaulted: the right one depends on what a
 * wrong answer costs. Closing the wrong task is cheap to notice and undo;
 * forgetting the wrong memory is not, so the callers pass different numbers
 * rather than sharing a constant that cannot be right for both.
 */
export function bestNamed<T>(
  phrase: string,
  items: T[],
  name: (item: T) => { id: string; title: string },
  floor = 0.5,
): Resolved<T> | undefined {
  let best: Resolved<T> | undefined;
  for (const item of items) {
    const { id, title } = name(item);
    const score = nameScore(phrase, title);
    if (score < floor) continue;
    // Ties keep the earlier item, and every caller feeds these in a
    // deterministic order, so the same phrase always resolves the same way.
    if (!best || score > best.score) best = { id, title, score, item };
  }
  return best;
}

/**
 * Tasks, in the order a person would mean them.
 *
 * Open work first, because "complete the deck review" is about something still
 * open, then the overdue list, then everything today touches. `lifeState.tasks`
 * carries focus (the ordered open list) and overdue; a completed task is not
 * resolvable here on purpose, since completing something already complete is
 * either a no-op or a mistake, and refusing is the honest answer to both.
 */
export function resolveTask(phrase: string, state: LifeState): Resolved<Named> | undefined {
  const seen = new Set<string>();
  const candidates: Named[] = [];
  for (const t of [...state.tasks.focus, ...state.tasks.overdue]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    candidates.push({ id: t.id, title: t.title });
  }
  return bestNamed(phrase, candidates, (c) => c, 0.5);
}

/**
 * A calendar entry. Only what the life state can see: today, plus the single
 * "next" event, which is what someone means by "cancel the standup" when it is
 * later in the week. The state carries no second day, and a resolver that
 * invented one would be matching against entries nothing else can display.
 */
export function resolveEvent(phrase: string, state: LifeState): Resolved<Named> | undefined {
  const seen = new Set<string>();
  const candidates: Named[] = [];
  const all = [
    ...state.calendar.today,
    ...(state.calendar.next ? [state.calendar.next] : []),
  ];
  for (const e of all) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    candidates.push({ id: e.id, title: e.title });
  }
  return bestNamed(phrase, candidates, (c) => c, 0.5);
}

export function resolveGoal(phrase: string, state: LifeState): Resolved<Named> | undefined {
  const candidates: Named[] = state.goals.map(({ goal }) => ({ id: goal.id, title: goal.title }));
  return bestNamed(phrase, candidates, (c) => c, 0.5);
}

export function resolveHabit(phrase: string, state: LifeState): Resolved<Named> | undefined {
  const candidates: Named[] = state.habits.map((h) => ({ id: h.id, title: h.name }));
  return bestNamed(phrase, candidates, (c) => c, 0.5);
}

/**
 * Memories resolve at a higher floor than tasks.
 *
 * "Forget the thing about the key" must not quietly delete the wrong memory:
 * memories have no bin entry the user browses and no undo button in the chat,
 * so a wrong resolution here is the most expensive mistake in this file. Same
 * function, one number apart, which is the whole reason the floor is a
 * parameter.
 */
export function resolveMemory(phrase: string, state: LifeState): Resolved<Named> | undefined {
  const candidates: Named[] = state.memory.map((hit) => ({
    id: hit.memory.id,
    title: hit.memory.title,
  }));
  return bestNamed(phrase, candidates, (c) => c, 0.62);
}
