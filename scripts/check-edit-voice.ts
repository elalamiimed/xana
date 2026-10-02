/**
 * Changing something by voice, and never claiming a change that did not happen.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-edit-voice.ts
 *
 * WHY THIS FILE EXISTS
 *
 * On 2026-10-02 the user asked for a garbled task title to be fixed. There was
 * no path in the app that could rename a task, so nothing ran — and the reply
 * said "Done. The task is now titled …". The user found out by looking at the
 * list and came back with "I told you to update it, but you did not."
 *
 * Two things were missing and both are asserted here:
 *
 *   1. A door. "rename it to X" now resolves to an `update_task` intent that
 *      writes through the executor, with the referent resolved the way a person
 *      would resolve it and a refusal when the referent is ambiguous.
 *   2. A rule about what she may SAY. `guardUnmadeClaim` is driven here against
 *      the exact sentence pair from that transcript, because the prompt alone is
 *      advice and advice is not a mechanism.
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

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "xana-editvoice-"));
process.env.XANA_DATA_DIR = DATA_DIR;
writeFileSync(path.join(DATA_DIR, "settings.json"), "{}\n", { encoding: "utf8", mode: 0o600 });

const { getStore, closeStore } = await import("../src/lib/core/store");
const { buildLifeState, invalidateContext } = await import("../src/lib/context/gateway");
const { localMind } = await import("../src/lib/mind/local");
const { actionRule, claimsAChange, guardUnmadeClaim, looksLikeChangeRequest, NOTHING_CHANGED } =
  await import("../src/lib/mind/claims");

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

function group(title: string, run: () => void | Promise<void>): void | Promise<void> {
  console.log(`\n${title}\n`);
  try {
    return run();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${title} threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}

const say = async (text: string) => {
  const lifeState = await buildLifeState({ force: true });
  return localMind({ text, lifeState });
};

const store = getStore();
const titles = () =>
  store
    .listTasks({ status: ["open"] })
    .map((t) => t.title)
    .sort();

/**
 * Set the board to exactly these tasks.
 *
 * `invalidateContext` is not optional here. Writing to the store directly
 * bypasses the action path, and the action path is what drops the adapter
 * caches — without it the life state keeps answering with the world from before
 * the last `fresh()`, which shows up as "which one?" about a task that no longer
 * exists. That is a property of the cache, not of the handler, and finding it
 * cost an hour: the assertions below were blamed first.
 */
function fresh(...names: string[]): string[] {
  for (const task of store.listTasks({})) store.deleteTask(task.id);
  const ids = names.map((title) => store.createTask({ title, priority: 3, source: "user" }).id);
  invalidateContext();
  return ids;
}

/* ------------------------------------------------------------------ */

await group("The sentence that produced the lie", async () => {
  fresh("or whatever which one it's concerned.");
  const reply = await say("rename it to 2pm Academic Support meeting");
  check("the rename is an action, not a sentence", reply.outcome?.ok === true, JSON.stringify(reply.outcome));
  check("the effect says what happened", reply.outcome?.effect === "task.updated", String(reply.outcome?.effect));
  check("and the store agrees", titles().join("|") === "2pm Academic Support meeting", titles().join("|"));
  check("the reply names the change", /renamed to/i.test(reply.outcome?.message ?? ""), String(reply.outcome?.message));
});

await group("A named target beats the only-one rule", async () => {
  fresh("Aurora deck", "Tax return");
  await say("rename the Tax return task to File taxes");
  check("the named task changed", titles().includes("File taxes"), titles().join("|"));
  check("and the other one did not", titles().includes("Aurora deck"), titles().join("|"));
});

await group("Two candidates and no name: ask, do not guess", async () => {
  fresh("Aurora deck", "Tax return");
  const reply = await say("rename it to something else");
  check("nothing was written", titles().join("|") === "Aurora deck|Tax return", titles().join("|"));
  check("she asks which one", /which one\?/i.test(reply.text), reply.text);
  check("and reports no action", reply.outcome?.ok === false, JSON.stringify(reply.outcome));
});

await group("An edit that would erase the name is refused", async () => {
  fresh("Aurora deck");
  const reply = await say("rename it to");
  check("nothing was written", titles().join("|") === "Aurora deck", titles().join("|"));
  check("and she says why", /did not catch the new name/i.test(reply.outcome?.message ?? reply.text), reply.text);
});

await group("A patch touches one field and leaves the rest", async () => {
  const [id] = fresh("Aurora deck");
  store.updateTask(id!, { due: "2026-10-09T00:00:00.000Z", project: "Website", estimateMinutes: 90 });
  invalidateContext();

  const dueReply = await say("set the due date to tomorrow");
  const afterDue = store.taskById(id!);
  check(
    "the due date moved",
    afterDue?.due !== "2026-10-09T00:00:00.000Z",
    `${afterDue?.due} after ${JSON.stringify(dueReply.text || dueReply.outcome?.message)}`,
  );
  check("the title survived", afterDue?.title === "Aurora deck", String(afterDue?.title));
  check("the project survived", afterDue?.project === "Website", String(afterDue?.project));
  check("the estimate survived", afterDue?.estimateMinutes === 90, String(afterDue?.estimateMinutes));

  const priorityReply = await say("make it priority 1");
  const afterPriority = store.taskById(id!);
  check(
    "priority changed",
    afterPriority?.priority === 1,
    `${afterPriority?.priority} after ${JSON.stringify(priorityReply.text || priorityReply.outcome?.message)}`,
  );
  check("and nothing else did", afterPriority?.title === "Aurora deck" && afterPriority?.estimateMinutes === 90);

  const estimateReply = await say("give it 45 minutes");
  check(
    "the estimate changed",
    store.taskById(id!)?.estimateMinutes === 45,
    `${store.taskById(id!)?.estimateMinutes} after ${JSON.stringify(estimateReply.text || estimateReply.outcome?.message)}`,
  );
});

await group("An event request is not read as a task edit", async () => {
  fresh("Aurora deck");
  const reply = await say("move the meeting to Friday");
  check(
    "no task was updated",
    reply.outcome?.effect !== "task.updated",
    JSON.stringify(reply.outcome),
  );
});

/* ------------------------------------------------------------------ */
/* What she may say she did                                            */
/* ------------------------------------------------------------------ */

await group("The guard, against the transcript", async () => {
  const lie = 'Done. The task is now titled "2pm Academic Support meeting."';
  const guarded = guardUnmadeClaim(lie, { text: "Yes, please.", acted: false });
  check("the historical lie is replaced", guarded.replaced === true);
  check("with the honest line", guarded.text === NOTHING_CHANGED, guarded.text.slice(0, 60));

  check(
    "a first-person claim with no action is replaced",
    guardUnmadeClaim("I've renamed it.", { text: "rename it to X", acted: false }).replaced === true,
  );
  check(
    "and so is a bare Done",
    guardUnmadeClaim("Done.", { text: "add a task to call mom", acted: false }).replaced === true,
  );
  check(
    "a reply describing an action that DID run is left alone",
    guardUnmadeClaim("Renamed it — it's due tomorrow now.", { text: "rename it to X", acted: true }).replaced === false,
  );
  check(
    "a discussion of a past action is left alone",
    guardUnmadeClaim("You added that yesterday.", { text: "did I add milk to the list?", acted: false }).replaced ===
      false,
  );
  check(
    "so is a reply to a question that merely mentions a verb",
    guardUnmadeClaim("Nothing is scheduled at two.", { text: "what is at two?", acted: false }).replaced === false,
  );
  check(
    "an ordinary answer is untouched",
    guardUnmadeClaim("You slept 6.2 hours and the forecast dips after lunch.", {
      text: "how am I doing today?",
      acted: false,
    }).replaced === false,
  );
});

await group("The three conditions, one at a time", () => {
  check("a confirmation counts as a change request", looksLikeChangeRequest("Yes, please."));
  check("a bare yes does too", looksLikeChangeRequest("yes"));
  check("so does an imperative", looksLikeChangeRequest("retitle the Aurora task to Deck review"));
  check("a question does not", !looksLikeChangeRequest("did I add milk?"));
  check("nor does a statement", !looksLikeChangeRequest("the meeting is at two"));

  check("a first-person past tense is a claim", claimsAChange("I have updated the task."));
  check("a title change is a claim", claimsAChange('The task is now titled "X".'));
  check("describing the day is not", !claimsAChange("Your afternoon is done."));
  check("nor is reporting the user's own action", !claimsAChange("You added that yesterday."));
});

await group("The rule the model reads", () => {
  const none = actionRule(false);
  const some = actionRule(true);
  check("with no action it says so", /NOTHING WAS DONE THIS TURN/.test(none));
  check("and forbids the claim", /Never say or imply that you added/.test(none));
  check("with an action it limits the claim to it", /Describe it and nothing more/.test(some));
  check("the two are different", none !== some);
});

/* ------------------------------------------------------------------ */

console.log(`\n  ${passed} passed, ${failed} failed\n`);
closeStore();
try {
  rmSync(DATA_DIR, { recursive: true, force: true });
} catch {
  /* Windows holds the -wal briefly; the temp dir is not worth failing over. */
}
if (failed > 0) process.exit(1);
