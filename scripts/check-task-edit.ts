/**
 * Editing a task that already exists, and an event too.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-task-edit.ts
 *
 * WHY THIS FILE EXISTS
 *
 * The task list could be added to and ticked off, and nothing else. Moving one
 * item to another day — the most common edit there is, and the one that stops an
 * overdue task being noise on tonight's briefing — meant deleting it and
 * retyping it, which throws away its id, its creation date and any history
 * hanging off it.
 *
 * The last section applies the same reading to an event, because the schedule
 * room now offers the same edit and it inherits exactly the same risk. It lives
 * here rather than in `verify:cave.mjs` so it can run offline against a temp
 * database and without a new script entry.
 *
 * WHAT IS ACTUALLY BEING CHECKED
 *
 * A partial edit is only safe if the fields you did NOT mention survive it. That
 * is the whole risk: `due` is `undefined` on most tasks, so an implementation
 * that reads fields for truth instead of checking whether they were mentioned
 * will quietly blank the deadline every time someone fixes a typo in a title.
 * Two of the assertions below are that exact case, and one of them caught a real
 * bug — an unparseable date was being written as `null`, so a typo in the date
 * field DELETED the deadline rather than being refused.
 *
 * ISOLATION
 *
 * `XANA_DATA_DIR` is moved to a temp directory before the store is imported, and
 * a settings file is written immediately, because the store migrates
 * `<cwd>/.xana/settings.json` into the data dir when the target is missing —
 * which would MOVE a real file out of the user's project.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "xana-taskedit-"));
process.env.XANA_DATA_DIR = DATA_DIR;
writeFileSync(path.join(DATA_DIR, "settings.json"), "{}\n", { encoding: "utf8", mode: 0o600 });

const { getStore, closeStore } = await import("../src/lib/core/store");
const { runCaveOperation } = await import("../src/lib/cave/ops");
const { dateKeyInZone, hourMinuteInZone, instantFromWallClock } = await import("../src/lib/core/zone");

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

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

/**
 * Run an operation, capturing the `CaveError` message and status instead of
 * throwing, and keeping the payload so an assertion can read what came back.
 */
function attemptWith(
  op: Parameters<typeof runCaveOperation>[0],
  input: Record<string, unknown>,
): { ok: boolean; message: string; status: number; payload: ReturnType<typeof runCaveOperation> | undefined } {
  try {
    return { ok: true, message: "", status: 200, payload: runCaveOperation(op, input) };
  } catch (err) {
    const e = err as { message?: string; status?: number };
    return { ok: false, message: e.message ?? String(err), status: e.status ?? 500, payload: undefined };
  }
}

/** The op throws `CaveError`; this captures the message and status instead. */
function attempt(input: Record<string, unknown>): { ok: boolean; message: string; status: number } {
  return attemptWith("task.update", input);
}

const store = getStore();
const task = store.createTask({
  title: "Volunteering for Freshman Fiesta",
  due: "2026-09-30",
  priority: 1,
  source: "user",
});

/* ------------------------------------------------------------------ */
/* The edit that was missing                                           */
/* ------------------------------------------------------------------ */

group("Move a task to a new day", () => {
  const result = attempt({ id: task.id, due: "2026-10-02" });
  check("the edit is accepted", result.ok, result.message);

  const after = store.taskById(task.id);
  check("the date moved", after?.due === "2026-10-02", String(after?.due));
  check("the task kept its identity", after?.id === task.id, String(after?.id));
  check(
    "and its creation date",
    after?.createdAt === task.createdAt,
    `${after?.createdAt} vs ${task.createdAt}`,
  );
});

group("A partial edit leaves everything it did not mention alone", () => {
  // Give the task every field the editor can carry before renaming it. That is
  // the whole point of the group: a field the patch does not mention is a field
  // the save has no opinion about, and the way to prove it is to have something
  // in each one and read the record back afterwards.
  attempt({ id: task.id, project: "Aurora", priority: 1, estimateMinutes: 90 });
  const before = store.taskById(task.id);
  check(
    "set up with a date, a project, a priority and an estimate",
    before?.due === "2026-10-02" &&
      before?.project === "Aurora" &&
      before?.priority === 1 &&
      before?.estimateMinutes === 90,
    JSON.stringify({ due: before?.due, project: before?.project, priority: before?.priority, estimate: before?.estimateMinutes }),
  );

  // The risky one, and the exact accident that started this: the chat said a task
  // had been renamed and nothing had happened. A rename is now a patch whose only
  // key is `title`, so everything else has to be byte-identical afterwards.
  const result = attempt({ id: task.id, title: "Volunteering for Freshman Fiesta (renamed)" });
  check("the rename is accepted", result.ok, result.message);

  const after = store.taskById(task.id);
  check("the title changed", after?.title === "Volunteering for Freshman Fiesta (renamed)", String(after?.title));
  check("the date did NOT change", after?.due === before?.due, `${after?.due} vs ${before?.due}`);
  check("the project did NOT change", after?.project === before?.project, `${after?.project} vs ${before?.project}`);
  check("the priority did NOT change", after?.priority === before?.priority, `${after?.priority} vs ${before?.priority}`);
  check(
    "the estimate did NOT change",
    after?.estimateMinutes === before?.estimateMinutes,
    `${after?.estimateMinutes} vs ${before?.estimateMinutes}`,
  );
  check("the status did NOT change", after?.status === "open", String(after?.status));
  check("the source did NOT change", after?.source === "user", String(after?.source));

  attempt({ id: task.id, title: "Volunteering for Freshman Fiesta" });
});

group("The fields a real edit reaches for", () => {
  check("priority", attempt({ id: task.id, priority: 2 }).ok && store.taskById(task.id)?.priority === 2);
  check(
    "an estimate",
    attempt({ id: task.id, estimateMinutes: 90 }).ok && store.taskById(task.id)?.estimateMinutes === 90,
  );
  check("energy", attempt({ id: task.id, energy: "high" }).ok && store.taskById(task.id)?.energy === "high");
  check("a project", attempt({ id: task.id, project: "Aurora" }).ok && store.taskById(task.id)?.project === "Aurora");
  check(
    "tags",
    attempt({ id: task.id, tags: ["volunteering", "campus"] }).ok &&
      (store.taskById(task.id)?.tags ?? []).length === 2,
  );
  check("and several at once", attempt({ id: task.id, title: "Freshman Fiesta shift", priority: 3 }).ok);
  const after = store.taskById(task.id);
  check("with the date still intact", after?.due === "2026-10-02", String(after?.due));
});

/* ------------------------------------------------------------------ */
/* Clearing, and the bug this file caught                              */
/* ------------------------------------------------------------------ */

group("Removing a date is an intention, not an accident", () => {
  const viaNull = attempt({ id: task.id, due: null });
  check("null clears it", viaNull.ok && store.taskById(task.id)?.due === undefined, String(store.taskById(task.id)?.due));

  attempt({ id: task.id, due: "2026-10-02" });
  const viaEmpty = attempt({ id: task.id, due: "" });
  check(
    "an emptied field clears it too",
    viaEmpty.ok && store.taskById(task.id)?.due === undefined,
    String(store.taskById(task.id)?.due),
  );
});

group("A date it cannot read is refused, and does NOT erase the deadline", () => {
  attempt({ id: task.id, due: "2026-10-02" });
  const before = store.taskById(task.id)?.due;
  check("set up with a deadline", before === "2026-10-02", String(before));

  // THE REGRESSION. `cleanDate` returns null for junk, and mapping that straight
  // into the patch turned a typo into a deleted commitment.
  const junk = attempt({ id: task.id, due: "next tuesday" });
  check("junk is refused", !junk.ok, JSON.stringify(junk));
  check("the refusal is a 400", junk.status === 400, String(junk.status));
  check("the refusal says what to do", /YYYY-MM-DD/.test(junk.message), junk.message);
  check(
    "AND the existing deadline survived",
    store.taskById(task.id)?.due === "2026-10-02",
    String(store.taskById(task.id)?.due),
  );

  for (const bad of ["2026-13-45", "yesterday", "10/02/2026", 20261002, true]) {
    const refused = attempt({ id: task.id, due: bad });
    check(`"${String(bad)}" is refused`, !refused.ok);
    check(`"${String(bad)}" did not erase the date`, store.taskById(task.id)?.due === "2026-10-02");
  }
});

/* ------------------------------------------------------------------ */
/* Refusals that protect the data                                      */
/* ------------------------------------------------------------------ */

group("Edits that must not be applied", () => {
  check("an empty patch is refused", !attempt({ id: task.id }).ok);
  check("a blank title is refused", !attempt({ id: task.id, title: "   " }).ok);
  // An empty field is how a cleared text input arrives, so the editor cannot be
  // allowed to send it as a title: "rename it to" with nothing after it would
  // erase the task's name.
  check("an empty string title is refused", !attempt({ id: task.id, title: "" }).ok);
  check("an out-of-range priority is refused", !attempt({ id: task.id, priority: 9 }).ok);
  check("a nonsense energy is refused", !attempt({ id: task.id, energy: "lukewarm" }).ok);

  const missing = attempt({ id: "task_does_not_exist", due: "2026-10-02" });
  check("an unknown id is a 404", missing.status === 404, String(missing.status));
  check("and says so rather than throwing", !missing.ok);

  const overlong = attempt({ id: task.id, title: "x".repeat(400) });
  check("an overlong title is trimmed, not rejected", overlong.ok);
  check("to the column's length", (store.taskById(task.id)?.title ?? "").length <= 200);

  // The refusals above must not have changed anything.
  const after = store.taskById(task.id);
  check("after all the refusals the task is intact", after?.due === "2026-10-02", String(after?.due));
  check("and still open", after?.status === "open", String(after?.status));
});

group("An estimate it cannot read is refused, and does NOT erase the estimate", () => {
  const before = store.taskById(task.id)?.estimateMinutes;
  check("set up with an estimate", before === 90, String(before));

  // The same accident the date had. `cleanEstimate` answers `undefined` for
  // junk, and mapping that straight into the patch turned a typo in the estimate
  // field into a deleted estimate rather than a refusal.
  const junk = attempt({ id: task.id, estimateMinutes: "about an hour" });
  check("junk is refused", !junk.ok, JSON.stringify(junk));
  check("the refusal is a 400", junk.status === 400, String(junk.status));
  check(
    "AND the existing estimate survived",
    store.taskById(task.id)?.estimateMinutes === 90,
    String(store.taskById(task.id)?.estimateMinutes),
  );

  const zero = attempt({ id: task.id, estimateMinutes: 0 });
  check("zero is refused", !zero.ok);
  check("and did not erase it either", store.taskById(task.id)?.estimateMinutes === 90);
});

group("Clearing an estimate is an intention, not an accident", () => {
  const viaNull = attempt({ id: task.id, estimateMinutes: null });
  check(
    "null clears it",
    viaNull.ok && store.taskById(task.id)?.estimateMinutes === undefined,
    String(store.taskById(task.id)?.estimateMinutes),
  );

  attempt({ id: task.id, estimateMinutes: 90 });
  const viaEmpty = attempt({ id: task.id, estimateMinutes: "" });
  check(
    "an emptied field clears it too",
    viaEmpty.ok && store.taskById(task.id)?.estimateMinutes === undefined,
    String(store.taskById(task.id)?.estimateMinutes),
  );

  attempt({ id: task.id, estimateMinutes: 90 });
});

group("Editing is not confused with completing", () => {
  // Status has its own op because it carries `completed_at`. An edit must never
  // set that, or the "what did I finish" briefing would count a rename.
  runCaveOperation("task.setStatus", { id: task.id, status: "done" });
  const done = store.taskById(task.id);
  check("completing stamps a time", typeof done?.completedAt === "string" && done.completedAt.length > 0);

  attempt({ id: task.id, title: "Renamed after completing" });
  const renamed = store.taskById(task.id);
  check("a rename keeps the completion time", renamed?.completedAt === done?.completedAt, String(renamed?.completedAt));
  check("and does not change the status", renamed?.status === "done", String(renamed?.status));

  // And an edit must not resurrect a completed task.
  attempt({ id: task.id, due: "2026-11-01" });
  check("editing a completed task leaves it completed", store.taskById(task.id)?.status === "done");
});

/* ------------------------------------------------------------------ */
/* The same patch discipline, on an event                              */
/* ------------------------------------------------------------------ */

/**
 * Why the event half lives in this file.
 *
 * "Move Thursday's seminar to Friday" is the edit the schedule room now offers,
 * and the risk is identical to the task's: a patch that names one field must not
 * disturb the others, and a day and a clock typed into a form must come back as
 * the reading that was typed rather than as the host's reading of it. The rest
 * of `verify:cave` drives the HTTP route against a live server; this file runs
 * offline against a temp database and is already in the `check` chain as
 * `verify:task-edit`, so the assertion has somewhere to run without a new entry
 * in `package.json` (which this task must not touch).
 */
group("An event edit moves only what it names", () => {
  /** A wall clock in the app's zone as an instant, so this holds if the zone moves. */
  const at = (year: number, month: number, day: number, hour: number, minute: number) =>
    instantFromWallClock({ year, month, day, hour, minute }).toISOString();

  const event = store.createEvent({
    title: "Algorithms lecture",
    start: at(2026, 10, 5, 14, 0),
    end: at(2026, 10, 5, 15, 0),
    location: "Room 4",
    source: "user",
    xanaAuthored: false,
  });

  const renamed = attemptWith("event.update", { id: event.id, title: "Algorithms seminar" });
  check("a rename is accepted", renamed.ok, renamed.message);
  const afterRename = store.eventById(event.id);
  check("the title changed", afterRename?.title === "Algorithms seminar", String(afterRename?.title));
  check("the start did NOT move", afterRename?.start === event.start, `${afterRename?.start} vs ${event.start}`);
  check("the end did NOT move", afterRename?.end === event.end, `${afterRename?.end} vs ${event.end}`);
  check("the place did NOT change", afterRename?.location === "Room 4", String(afterRename?.location));

  const moved = attemptWith("event.update", { id: event.id, date: "2026-10-08", time: "09:30", minutes: 45 });
  check("moving it is accepted", moved.ok, moved.message);
  const afterMove = store.eventById(event.id);
  check(
    "it lands on the day that was typed",
    dateKeyInZone(new Date(afterMove?.start ?? 0)) === "2026-10-08",
    String(afterMove?.start),
  );
  check(
    "at the clock that was typed",
    hourMinuteInZone(new Date(afterMove?.start ?? 0)) === "09:30",
    String(afterMove?.start),
  );
  check(
    "with the length that was typed",
    new Date(afterMove?.end ?? 0).getTime() - new Date(afterMove?.start ?? 0).getTime() === 45 * 60_000,
    `${afterMove?.start} to ${afterMove?.end}`,
  );
  check("and the title survived the move", afterMove?.title === "Algorithms seminar", String(afterMove?.title));

  // A time on its own is the ordinary "push it back an hour" edit, and it must
  // not need the day restated.
  attemptWith("event.update", { id: event.id, time: "16:15" });
  const afterTime = store.eventById(event.id);
  check(
    "a time alone keeps the day",
    dateKeyInZone(new Date(afterTime?.start ?? 0)) === "2026-10-08",
    String(afterTime?.start),
  );
  check(
    "and keeps the length",
    new Date(afterTime?.end ?? 0).getTime() - new Date(afterTime?.start ?? 0).getTime() === 45 * 60_000,
  );
  check(
    "and moves the clock",
    hourMinuteInZone(new Date(afterTime?.start ?? 0)) === "16:15",
    String(afterTime?.start),
  );

  const cleared = attemptWith("event.update", { id: event.id, location: "" });
  check(
    "an emptied place clears it",
    cleared.ok && store.eventById(event.id)?.location === undefined,
    String(store.eventById(event.id)?.location),
  );

  check("a blank title is refused", !attemptWith("event.update", { id: event.id, title: "   " }).ok);
  check(
    "a date it cannot read is refused",
    !attemptWith("event.update", { id: event.id, date: "next tuesday" }).ok,
  );
  check("a time it cannot read is refused", !attemptWith("event.update", { id: event.id, time: "half four" }).ok);
  check("nothing to change is refused", !attemptWith("event.update", { id: event.id }).ok);

  const missingEvent = attemptWith("event.update", { id: "evt_does_not_exist", title: "Nope" });
  check("an unknown event is a 404", missingEvent.status === 404, String(missingEvent.status));
  check(
    "after all the refusals the event is intact",
    store.eventById(event.id)?.title === "Algorithms seminar",
    String(store.eventById(event.id)?.title),
  );
});

/* ------------------------------------------------------------------ */

closeStore();
rmSync(DATA_DIR, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
