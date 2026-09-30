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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
