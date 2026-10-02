/**
 * Delete, and take it back.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-trash.ts
 *
 * WHAT THIS PROVES, AND WHY IT NEEDS PROVING
 *
 * A trash bin is a promise with two halves, and the second one is the half that
 * usually breaks. The first half is that a deleted thing can be recovered, which
 * is easy to demonstrate. The second is that a deleted thing is *actually gone*
 * until it is: out of the task list, out of the briefing's sources, out of
 * recall, out of the counts. A bin that holds a copy while the original is still
 * being read is not a bin, it is a second list.
 *
 * That is why this file asserts through the real read methods rather than
 * against the trash table. A row that has moved out of its table is missing from
 * every query that was ever written against it — including the ones written
 * after this file — and these are the calls the briefing, the derived layers and
 * the cave actually make.
 *
 * The third thing is the window. Seven days is a promise about time, so it is
 * driven with an injected clock rather than by waiting.
 *
 * AND IT NEVER TOUCHES THE REAL DATABASE
 *
 * Everything here runs against a scratch store in a temp directory, and the
 * first line of the file asserts that the mind's own `getStore()` resolves to
 * it. That guard is not defensive decoration: an earlier version passed the
 * scratch store to the calls made directly and let `executeAction` resolve the
 * real one, so running this check deleted a task from the live list. It was
 * recoverable — the feature under test is a trash bin — and it is exactly the
 * class of accident a check must not be capable of.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { XanaStore, getStore, setStore } from "../src/lib/core/store";
import { TRASH_DAYS } from "../src/lib/core/types";
import { executeAction } from "../src/lib/actions/executor";
import { knownKeys } from "../src/lib/derived/memory";
import { localMind } from "../src/lib/mind/local";
import { runCaveOperation } from "../src/lib/cave/ops";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function group(title: string, run: () => void): void {
  console.log(`\n${title}\n`);
  try {
    run();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${title} threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "xana-trash-"));
const store = new XanaStore(path.join(dir, "trash.db"));
// The cave's operations resolve the store through `getStore()`; pointing that at
// this one keeps the whole file off the real database.
setStore(store);

/**
 * A check that writes to the user's real database is not a check, it is an
 * incident — and this one caught itself having exactly that.
 *
 * The first version of this file passed the scratch store to the calls it made
 * directly and let `executeAction` and the intent engine resolve their own,
 * which is the live one: `npm run verify:trash` quietly removed a task from the
 * real list. It was recoverable, because the thing being tested is a bin, and it
 * still cost a minute of somebody's trust. The assertion below is the difference
 * between a mistake and a repeat.
 */
if (getStore() !== store) {
  throw new Error("The scratch store is not the one the mind will use — refusing to run against the real database.");
}

/* ------------------------------------------------------------------ */
/* A task                                                              */
/* ------------------------------------------------------------------ */

group("A deleted task is gone from everywhere it was read", () => {
  const task = store.createTask({ title: "Review the Aurora deck", due: "2026-10-06T09:00:00.000Z", priority: 2 });
  check("it starts in the open list", store.listTasks({ status: ["open"] }).some((t) => t.id === task.id));

  check("delete reports that it took", store.deleteTask(task.id));
  check("it is out of the list", !store.listTasks({ status: ["open"] }).some((t) => t.id === task.id));
  check("out of the single lookup", store.taskById(task.id) === undefined);
  check("and out of the counts", !("tasks" in store.counts()) || store.counts().tasks === 0, JSON.stringify(store.counts().tasks));

  const bin = store.listTrash();
  const entry = bin.find((item) => item.id === task.id);
  check("it is in the bin", Boolean(entry), JSON.stringify(bin));
  check("as a task", entry?.kind === "task", entry?.kind);
  check("under its own title", entry?.title === "Review the Aurora deck", entry?.title);
  check("with the full week left", entry?.daysLeft === 7, String(entry?.daysLeft));

  check("restore reports that it took", store.restoreFromTrash("task", task.id));
  const back = store.taskById(task.id);
  check("and it is back", Boolean(back));
  check("with its due date", back?.due === "2026-10-06T09:00:00.000Z", back?.due);
  check("and its priority", back?.priority === 2, String(back?.priority));
  check("and the bin is empty again", store.listTrash().length === 0);
});

/* ------------------------------------------------------------------ */
/* Everything else that can be deleted                                 */
/* ------------------------------------------------------------------ */

group("Events, notes, goals and memories all take the same route", () => {
  const event = store.createEvent({ title: "Standup", start: "2026-10-05T09:00:00.000Z", end: "2026-10-05T09:15:00.000Z" });
  store.deleteEvent(event.id);
  check(
    "an event leaves the calendar",
    !store.eventsBetween("2026-10-05T00:00:00.000Z", "2026-10-05T23:59:59.000Z").some((e) => e.id === event.id),
  );
  check("and waits in the bin", store.listTrash().some((i) => i.kind === "event" && i.id === event.id));
  check("until it is restored", store.restoreFromTrash("event", event.id));
  check(
    "and the calendar has it again",
    store.eventsBetween("2026-10-05T00:00:00.000Z", "2026-10-05T23:59:59.000Z").some((e) => e.id === event.id),
  );

  const note = store.createNote({ title: "Plumber", body: "Quoted 340 for the valve." });
  store.deleteNote(note.id);
  check("a note leaves the list", !store.listNotes().some((n) => n.id === note.id));
  check("and comes back whole", store.restoreFromTrash("note", note.id) && store.listNotes().some((n) => n.id === note.id));

  const goal = store.createGoal({
    title: "Run a half marathon",
    horizon: "mid",
    milestones: [{ title: "10k without stopping" }, { title: "Book the race" }],
  });
  check("the goal starts with its milestones", store.goalById(goal.id)?.milestones.length === 2, String(store.goalById(goal.id)?.milestones.length));

  store.deleteGoal(goal.id);
  check("a deleted goal leaves the board", !store.listGoals(["active"]).some((g) => g.id === goal.id));
  check("and leaves allGoals too", !store.allGoals().some((g) => g.id === goal.id));
  check(
    "the bin shows the goal as one row, not one row per step",
    store.listTrash().filter((i) => i.kind === "goal").length === 1 &&
      store.listTrash().filter((i) => i.kind === "milestone").length === 0,
    JSON.stringify(store.listTrash().map((i) => i.kind)),
  );
  check(
    "and the row says how many steps came with it",
    store.listTrash().find((i) => i.kind === "goal")?.steps === 2,
    String(store.listTrash().find((i) => i.kind === "goal")?.steps),
  );

  check("restoring the goal works", store.restoreFromTrash("goal", goal.id));
  const restored = store.goalById(goal.id);
  check("and it is on the board again", store.listGoals(["active"]).some((g) => g.id === goal.id));
  check("with its milestones back", restored?.milestones.length === 2, String(restored?.milestones.length));
  check("and an empty bin behind it", store.listTrash().length === 0, JSON.stringify(store.listTrash()));
});

/**
 * A goal removed for good takes its steps with it.
 *
 * The first version of the bin left them behind: milestones whose goal no
 * longer existed, still restorable, into a board that could never show them.
 * The rows are asserted through `restoreFromTrash` rather than through the
 * listing, because the listing hides them once their goal is in the bin — a
 * test that only read the listing would pass while the rows piled up.
 */
group("Deleting a goal for good takes its steps with it", () => {
  const doomed = store.createGoal({
    title: "Abandoned plan",
    horizon: "short",
    milestones: [{ title: "Draft the outline" }, { title: "Ask for feedback" }],
  });
  const stepIds = (store.goalById(doomed.id)?.milestones ?? []).map((m) => m.id);
  check("the doomed goal has two steps", stepIds.length === 2);

  store.deleteGoal(doomed.id);
  check("it is in the bin", store.listTrash().some((i) => i.kind === "goal" && i.id === doomed.id));

  check("purging it for good takes", store.purgeOne("goal", doomed.id));
  check("the goal is out of the bin", !store.listTrash().some((i) => i.id === doomed.id));
  check(
    "its steps are gone with it, not merely hidden",
    stepIds.every((id) => store.restoreFromTrash("milestone", id) === false),
    JSON.stringify(store.listTrash()),
  );
  check("and the bin is empty", store.listTrash().length === 0, JSON.stringify(store.listTrash()));
});

/**
 * A single step removed on its own is a different thing.
 *
 * Its goal is still on the board, so it is listed, it can be put back, and it
 * must be — the rule that hides steps is about steps whose goal is in the bin
 * with them, not about steps.
 */
group("A step removed on its own can be put back", () => {
  const kitchen = store.createGoal({
    title: "Redo the kitchen",
    horizon: "mid",
    milestones: [{ title: "Measure the wall" }, { title: "Order the tiles" }],
  });
  const step = store.goalById(kitchen.id)?.milestones[0];
  check("the goal has a first step", Boolean(step));

  store.deleteMilestone(step!.id);
  check(
    "the step leaves the goal",
    store.goalById(kitchen.id)?.milestones.length === 1,
    String(store.goalById(kitchen.id)?.milestones.length),
  );
  check(
    "and it IS listed in the bin, because its goal is not",
    store.listTrash().some((i) => i.kind === "milestone" && i.id === step!.id),
    JSON.stringify(store.listTrash().map((i) => `${i.kind}:${i.title}`)),
  );
  check("restoring it works", store.restoreFromTrash("milestone", step!.id));
  check(
    "and the goal has both steps again",
    store.goalById(kitchen.id)?.milestones.length === 2,
    String(store.goalById(kitchen.id)?.milestones.length),
  );
  check("leaving an empty bin", store.listTrash().length === 0, JSON.stringify(store.listTrash()));
});

/**
 * The memory case is the one with something to lose.
 *
 * A memory carries its embedding as a BLOB, and a JSON round trip through the
 * bin turns a Buffer into `{type: "Buffer", data: [...]}`. Stored back
 * unhandled, the restored memory is present, readable, and invisible to recall —
 * which is the worst possible shape for this bug, because it looks restored.
 */
group("A forgotten memory comes back still findable", () => {
  const memory = store.remember({
    kind: "decision",
    title: "Quarterly budget",
    content: "The quarterly budget was approved at 42k, with the training line doubled.",
    entities: ["budget"],
    tags: ["decision"],
    salience: 0.8,
    source: "local",
  });

  const before = store.recall("what did I decide about the quarterly budget", { limit: 5 });
  check("recall finds it to begin with", before.some((hit) => hit.memory.id === memory.id), JSON.stringify(before.map((h) => h.memory.title)));

  check("forgetting takes", store.forgetMemory(memory.id));
  check("it leaves allMemories", !store.allMemories().some((m) => m.id === memory.id));
  check("and recall cannot find it", !store.recall("quarterly budget", { limit: 5 }).some((h) => h.memory.id === memory.id));
  check("while the bin holds it", store.listTrash().some((i) => i.kind === "memory" && i.id === memory.id));

  check("restoring takes", store.restoreFromTrash("memory", memory.id));
  check("it is in allMemories again", store.allMemories().some((m) => m.id === memory.id));
  check(
    "AND recall finds it again — the embedding survived the round trip",
    store.recall("what did I decide about the quarterly budget", { limit: 5 }).some((hit) => hit.memory.id === memory.id),
    "a restored memory that recall cannot see is the worst version of this bug",
  );
});

/* ------------------------------------------------------------------ */
/* The window                                                          */
/* ------------------------------------------------------------------ */

/**
 * A derived memory must not come back from the dead.
 *
 * Every key in `knownKeys` is a projection of live data — a note, a completed
 * task, a week of sleep — so an ingest pass that cannot see the bin writes the
 * record straight back. This was watched happening on the real database: a
 * sleep average forgotten at 23:52 was in the list again at 23:54, which meant
 * the list of things to delete grew while it was being deleted.
 *
 * The assertion is on `knownKeys` rather than on a second ingest, because the
 * ingest is the caller and the key set is the decision it makes.
 */
group("A forgotten derived memory stays forgotten", () => {
  const derived = store.remember({
    kind: "fact",
    title: "Sleep averaged 7.3h over 6 days",
    content: "Trailing sleep average with 1.2h of debt.",
    entities: [],
    tags: ["health", "sleep", "key:health-sleep:2026-10-02"],
    salience: 0.3,
    source: "health",
  });
  const key = "health-sleep:2026-10-02";

  check("the key is known while the memory is live", knownKeys(store).has(key));
  check("forgetting it takes", store.forgetMemory(derived.id));
  check(
    "and the key is still known, from the bin",
    knownKeys(store).has(key),
    "without this the next ingest pass re-derives it within the minute",
  );
  check("the bin holds it", store.listTrash().some((i) => i.kind === "memory" && i.id === derived.id));

  check("restoring it puts it back", store.restoreFromTrash("memory", derived.id));
  check("and the key is known from the memory itself again", knownKeys(store).has(key));

  // Past the deadline the tombstone is gone, and so is the record of the
  // decision: the fact is free to be derived again. That is the bin's window,
  // not a second and quieter rule about forgetting.
  store.forgetMemory(derived.id);
  store.purgeOne("memory", derived.id);
  check("once the tombstone is purged the key is free again", !knownKeys(store).has(key));
  check("and the bin is empty behind it", store.listTrash().length === 0, JSON.stringify(store.listTrash()));
});

group("Seven days, and then it is really gone", () => {
  const task = store.createTask({ title: "Old mistake" });
  store.deleteTask(task.id);
  check("it is in the bin now", store.listTrash().some((i) => i.id === task.id));

  const inSixDays = new Date(Date.now() + 6 * 86_400_000);
  check("six days later nothing has been purged", store.purgeTrash(inSixDays) === 0, "an early purge is data loss");
  check("and it is still restorable", store.listTrash().some((i) => i.id === task.id));

  const inEightDays = new Date(Date.now() + 8 * 86_400_000);
  check("eight days later it is", store.purgeTrash(inEightDays) === 1, String(store.purgeTrash(inEightDays)));
  check("and it is gone from the bin", !store.listTrash().some((i) => i.id === task.id));
  check("and gone for good", !store.restoreFromTrash("task", task.id));

  check("the window is the promised one", TRASH_DAYS === 7, String(TRASH_DAYS));

  // Emptying on purpose is the one delete with no way back, so it is its own verb.
  const another = store.createTask({ title: "Also a mistake" });
  store.deleteTask(another.id);
  check("emptying the bin reports what it dropped", store.emptyTrash() === 1, String(store.emptyTrash()));
  check("and leaves nothing", store.listTrash().length === 0);
});

/* ------------------------------------------------------------------ */
/* Saying it out loud                                                  */
/* ------------------------------------------------------------------ */

group("Asking her to remove things, in the words people use", () => {
  // From a known list. An earlier group left a task open on purpose (it was
  // restored to prove restoring works), and this group is about what the words
  // do — not about what happened to be lying around.
  store.deleteTasks(store.listTasks({ status: ["open", "doing"] }).map((t) => t.id));
  store.emptyTrash();

  const first = store.createTask({ title: "Book the dentist follow-up" });
  store.createTask({ title: "Draft the proposal letter" });
  store.createTask({ title: "Send the invoice" });

  // By name, through the executor.
  const one = executeAction({ type: "delete_task", taskId: first.id }, { store, noInvalidate: true });
  check("one task can be named and removed", one.ok && one.effect === "task.deleted", one.effect);
  check("and she says where it went", /trash|back/i.test(one.message), one.message);
  check("it is out of the list", !store.listTasks({ status: ["open"] }).some((t) => t.id === first.id));

  // Everything, in the words the report arrived in.
  const spoken = localMind({ text: "remove everything", lifeState: emptyState(), sessionId: "trash-test" });
  check("'remove everything' is understood", /trash|removed|back/i.test(spoken.text), spoken.text);
  check("and the open list is empty", store.listTasks({ status: ["open"] }).length === 0, String(store.listTasks({ status: ["open"] }).length));
  check(
    "with every one of them recoverable",
    store.listTrash().filter((i) => i.kind === "task").length === 3,
    JSON.stringify(store.listTrash().map((i) => `${i.kind}:${i.title}`)),
  );

  // The same verb, the other way of saying it.
  store.createTask({ title: "One more" });
  const cleared = localMind({ text: "clear the list", lifeState: emptyState(), sessionId: "trash-test" });
  check("'clear the list' means the same thing", /trash|removed|back/i.test(cleared.text), cleared.text);
  check("and it took the last one", store.listTasks({ status: ["open"] }).length === 0);

  // A phrase that names something is resolved, not treated as a bulk delete.
  const dentist = store.createTask({ title: "Book the dentist follow-up" });
  const bystander = store.createTask({ title: "Renew the passport" });
  const named = localMind({
    text: "delete the dentist thing",
    lifeState: stateWith(dentist.id, dentist.title),
    sessionId: "trash-test",
  });
  check("a named removal resolves against the list", /gone|trash/i.test(named.text), named.text);
  check("and takes the one it named", store.taskById(dentist.id) === undefined, named.text);
  check("leaving the rest alone", Boolean(store.taskById(bystander.id)), "a fuzzy match must not clear the list");

  store.deleteTask(bystander.id);
  const empty = executeAction({ type: "clear_tasks" }, { store, noInvalidate: true });
  check("clearing an empty list is honest about it", empty.ok && /nothing|already/i.test(empty.message), empty.message);
});

/**
 * The dangerous half of a bulk delete is what it does to sentences that are not
 * one. Each of these is a real way people talk, and every one of them must reach
 * the rest of the mind rather than the task list.
 */
group("Conversation that must not empty the list", () => {
  store.deleteTasks(store.listTasks({ status: ["open", "doing"] }).map((t) => t.id));
  store.emptyTrash();
  const survivor = store.createTask({ title: "Survive this sentence" });

  const sentences = [
    "forget it",
    "forget about it",
    "drop it",
    "never mind",
    "cancel that",
    "forget about my tasks for now and let's talk about this loneliness thing",
  ];
  for (const sentence of sentences) {
    const answer = localMind({ text: sentence, lifeState: emptyState(), sessionId: "trash-test" });
    const survived = Boolean(store.taskById(survivor.id));
    check(`"${sentence}" does not clear the list`, survived, answer.text);
  }
  check("and the bin is still empty", store.listTrash().length === 0, String(store.listTrash().length));
});

/* ------------------------------------------------------------------ */
/* The room's own path                                                 */
/* ------------------------------------------------------------------ */

/**
 * The cave does not call the store directly — it goes through `runCaveOperation`,
 * which is what the Trash room's buttons hit. That extra layer is exactly where
 * a working feature stops being one, so it is driven here rather than assumed.
 */
group("The bin the interface reads and writes", () => {
  getStoreForTrash().emptyTrash();

  const task = store.createTask({ title: "Thing removed from the cave" });
  runCaveOperation("task.delete", { id: task.id });

  const listed = runCaveOperation("trash.list", {}).trash ?? [];
  check("trash.list returns the bin", listed.length === 1, String(listed.length));
  check("with the kind on it, so the room can label it", listed[0]?.kind === "task", listed[0]?.kind);
  check("and the days it has left", listed[0]?.daysLeft === 7, String(listed[0]?.daysLeft));

  runCaveOperation("trash.restore", { kind: "task", id: task.id });
  check("trash.restore brings it back", Boolean(store.taskById(task.id)));
  check("and the room's list is empty again", (runCaveOperation("trash.list", {}).trash ?? []).length === 0);

  // Delete for good, ahead of the deadline: the only irreversible verb here.
  store.deleteTask(task.id);
  runCaveOperation("trash.purge", { kind: "task", id: task.id });
  check("trash.purge drops it now", (runCaveOperation("trash.list", {}).trash ?? []).length === 0);
  check("and it cannot be restored afterwards", !store.restoreFromTrash("task", task.id));

  const throwaway = store.createTask({ title: "Another" });
  store.deleteTask(throwaway.id);
  runCaveOperation("trash.empty", {});
  check("trash.empty clears the lot", (runCaveOperation("trash.list", {}).trash ?? []).length === 0);

  let refused = false;
  try {
    runCaveOperation("trash.restore", { kind: "sausage", id: "x" });
  } catch {
    refused = true;
  }
  check("a nonsense kind is refused rather than guessed at", refused);

  /**
   * A note can reach the bin, which it could not before.
   *
   * `note` has been a bin kind since the beginning — the store could move one
   * in and put one back — and no route called either, so the only way to delete
   * a note was to open the database by hand. The assertion is on the operation
   * rather than the store method, because the store method was never the part
   * that was missing.
   */
  const note = store.createNote({ title: "Plumber", body: "Quoted 340 for the valve." });
  runCaveOperation("note.delete", { id: note.id });
  check("a note can be deleted through the route", !store.listNotes().some((n) => n.id === note.id));
  check(
    "and it lands in the bin rather than nowhere",
    (runCaveOperation("trash.list", {}).trash ?? []).some((i) => i.kind === "note" && i.id === note.id),
    JSON.stringify((runCaveOperation("trash.list", {}).trash ?? []).map((i) => `${i.kind}:${i.title}`)),
  );
  runCaveOperation("trash.restore", { kind: "note", id: note.id });
  check("and comes back to the note list", store.listNotes().some((n) => n.id === note.id));

  let missing = false;
  try {
    runCaveOperation("note.delete", { id: "note_does_not_exist" });
  } catch {
    missing = true;
  }
  check("deleting a note that is not there is a 404, not a silent success", missing);
  getStoreForTrash().emptyTrash();
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
store.close();
rmSync(dir, { recursive: true, force: true });
process.exitCode = failed === 0 ? 0 : 1;

/** The cave's operations resolve the store themselves; this is that handle. */
function getStoreForTrash(): XanaStore {
  setStore(store);
  return store;
}

/** A life state with nothing in it, for the intent-engine cases above. */
function emptyState() {
  return {
    generatedAt: new Date().toISOString(),
    partOfDay: "evening" as const,
    headline: "",
    energy: { score: 50, band: "steady" as const, note: "", windows: [] },
    calendar: { today: [], tomorrow: [], next: undefined, freeMinutes: 0 },
    tasks: { focus: [], overdue: [], openCount: 0, completedThisWeek: 0 },
    habits: [],
    goals: [],
    health: { latest: undefined, sleepAvgHours: undefined, sleepDebtHours: 0 },
    memory: [],
    patterns: [],
    nudges: [],
    finance: [],
    mail: [],
    sources: [],
  } as unknown as Parameters<typeof localMind>[0]["lifeState"];
}

/** The same, with one open task in it — what she can see when she is asked. */
function stateWith(id: string, title: string) {
  const state = emptyState() as unknown as { tasks: { focus: unknown[]; openCount: number } };
  state.tasks.focus = [
    {
      id,
      title,
      status: "open" as const,
      priority: 3,
      tags: [],
      people: [],
      source: "xana",
      createdAt: new Date().toISOString(),
    },
  ];
  state.tasks.openCount = 1;
  return state as unknown as Parameters<typeof localMind>[0]["lifeState"];
}
