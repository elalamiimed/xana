/**
 * Editing a task that already exists.
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

/** The op throws `CaveError`; this captures the message and status instead. */
function attempt(input: Record<string, unknown>): { ok: boolean; message: string; status: number } {
  try {
    runCaveOperation("task.update", input);
    return { ok: true, message: "", status: 200 };
  } catch (err) {
    const e = err as { message?: string; status?: number };
    return { ok: false, message: e.message ?? String(err), status: e.status ?? 500 };
  }
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
  // The risky one. `due` is a real date here, and a title-only patch must not
  // touch it.
  const result = attempt({ id: task.id, title: "Volunteering for Freshman Fiesta (renamed)" });
  check("the rename is accepted", result.ok, result.message);

  const after = store.taskById(task.id);
  check("the title changed", after?.title === "Volunteering for Freshman Fiesta (renamed)", String(after?.title));
  check("the date did NOT change", after?.due === "2026-10-02", String(after?.due));
  check("the priority did NOT change", after?.priority === 1, String(after?.priority));
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

closeStore();
rmSync(DATA_DIR, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
