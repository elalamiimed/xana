/**
 * Does clearing a list actually clear it?
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-refresh.ts
 *
 * The bug this exists for: `reduceLifeState` folds a fresh life state onto the
 * previous one so a section that did not arrive is not blanked while someone is
 * reading it. That is right for a section that is genuinely optional, and wrong
 * for one that is merely empty — and `tasks` was in the list. So an empty task
 * list was read as a missing one, the previous tasks were put back, and
 * deleting a task looked like it had not worked. The database said one task;
 * the panel said three; a reload said one again.
 *
 * The failure has no error, no log and no type problem, which is exactly why it
 * needs an assertion rather than care.
 */

import { reduceLifeState } from "../src/components/xana/useXana";
import type { LifeState, Task } from "../src/lib/core/types";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const task = (id: string, title: string): Task =>
  ({ id, title, status: "open", priority: 3, source: "local", createdAt: new Date().toISOString(), people: [], tags: [] }) as Task;

/** A state carrying a given set of open tasks. */
const withTasks = (tasks: Task[]): LifeState =>
  ({
    generatedAt: new Date().toISOString(),
    partOfDay: "afternoon",
    headline: "x",
    calendar: { today: [], freeMinutes: 0 },
    tasks: { focus: tasks, overdue: [], openCount: tasks.length, completedThisWeek: 0 },
    habits: [],
    goals: [],
    health: { moodTrend: [], sleepDebtHours: 0 },
    finance: [],
    mail: [],
    patterns: [],
    energy: { score: 40, band: "steady", note: "", windows: [] },
    nudges: [],
    sources: [],
    memory: [],
    focus: { sessionsThisWeek: [], totalMinutes: 0 },
  }) as unknown as LifeState;

console.log("\nClearing a list\n");

const three = withTasks([task("a", "Review Sam's parser PR"), task("b", "Send Mom the photos"), task("c", "Draft the launch post")]);
const none = withTasks([]);

const folded = reduceLifeState(three, none);
check(
  "an empty task list stays empty after folding",
  folded.tasks.focus.length === 0,
  `folded to ${folded.tasks.focus.length}: ${folded.tasks.focus.map((t) => t.title).join(", ")}`,
);
check("and the count follows it", folded.tasks.openCount === 0, String(folded.tasks.openCount));

const kept = reduceLifeState(three, withTasks([task("d", "Volunteering for Freshman Fiesta")]));
check(
  "a replaced list is the new list, not a merge",
  kept.tasks.focus.length === 1 && kept.tasks.focus[0].id === "d",
  kept.tasks.focus.map((t) => t.title).join(", "),
);

// Going from nothing to something is the easy direction, but it is the one a
// naive "keep the previous" would also break in reverse.
const filled = reduceLifeState(none, three);
check("an arriving task list is adopted", filled.tasks.focus.length === 3, String(filled.tasks.focus.length));

console.log("\nWhat is still folded\n");

/**
 * The sections that remain on the keep-previous list must stay there, or this
 * fix would trade one bug for another: a chat reply that omits a section would
 * blank it mid-read.
 */
const rich = {
  ...withTasks([]),
  patterns: [{ id: "p1", key: "k", observation: "o", confidence: 0.5, basis: "b", evidence: [], detectedAt: "" }],
  memory: [{ memory: { id: "m1", title: "t", content: "c" }, score: 1, reason: "r" }],
} as unknown as LifeState;

const thin = { ...withTasks([]), patterns: [], memory: [] } as unknown as LifeState;
const held = reduceLifeState(rich, thin);
check("a section that did not arrive keeps its previous value", held.patterns.length === 1, String(held.patterns.length));
check("and so does memory", held.memory.length === 1, String(held.memory.length));
check("while the task list still follows the data", held.tasks.focus.length === 0);

console.log("\nA goal with nothing done\n");

/**
 * "on-track" for a goal nobody has started is technically true and completely
 * misleading — the only thing being tracked is the passage of time. All three
 * goals read that way at 0%.
 *
 * The floor matters as much as the label: a goal written down this morning is
 * not behind, it is new, and a board that says otherwise is unusable on the day
 * it is set up.
 */
const { computeGoalProgress } = await import("../src/lib/derived/goals");
const now = new Date("2026-06-01T12:00:00");

/**
 * `touchedAt` is the goal's last-movement stamp. It has to be recent or the
 * 21-day staleness rule fires first and every case comes back "stalled" —
 * which is what the first version of this fixture did, and it made the test
 * look like it was testing the pace rules while actually testing nothing but
 * the staleness floor.
 */
const goal = (
  createdAt: string,
  targetDate: string,
  doneCount = 0,
  of = 4,
  touchedAt = "2026-05-28T00:00:00",
) =>
  ({
    id: "g",
    title: "g",
    horizon: "short",
    status: "active",
    createdAt,
    targetDate,
    lastTouchedAt: touchedAt,
    milestones: Array.from({ length: of }, (_, i) => ({
      id: `m${i}`,
      title: `m${i}`,
      done: i < doneCount,
      completedAt: i < doneCount ? "2026-05-28T00:00:00" : undefined,
    })),
  }) as never;

// Five months in on a year-long goal, nothing done.
const unstarted = computeGoalProgress(goal("2026-01-01T00:00:00", "2027-01-01"), now);
check(
  "an unstarted goal past a quarter of its window is not called on-track",
  unstarted.pace === "not-started",
  unstarted.pace,
);
check("and it says so in its own words", unstarted.note === "Nothing started yet.", unstarted.note);

// Written down today: on track, because there is nothing yet to be behind on.
const fresh = computeGoalProgress(goal("2026-06-01T00:00:00", "2027-01-01"), now);
check("a goal created today is not accused of anything", fresh.pace === "on-track", fresh.pace);

// One milestone done is a rate, and the ordinary rules apply to it again.
const started = computeGoalProgress(goal("2026-01-01T00:00:00", "2027-01-01", 1), now);
check(
  "a goal with something done keeps the ordinary pace rules",
  started.pace === "slipping",
  started.pace,
);

// No target date means no window to be behind in.
const undated = computeGoalProgress(goal("2026-01-01T00:00:00", "", 0), now);
check("a goal with no deadline is left on the momentum rule", undated.pace !== "not-started", undated.pace);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
