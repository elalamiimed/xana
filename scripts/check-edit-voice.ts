/**
 * Changing something by voice, and never claiming a change that did not happen.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-edit-voice.ts
 *
 * WHY THIS FILE EXISTS
 *
 * In one session the user asked for a garbled task title to be fixed. There was
 * no path in the app that could rename a task, so nothing ran — and the reply
 * said "Done. The task is now titled …". The user found out by looking at the
 * list and came back with "The title had still not changed."
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
const { actionRule, claimsAChange, deniesAnActionThatRan, guardUnmadeClaim, looksLikeChangeRequest, NOTHING_CHANGED } =
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
  /*
   * Synthetic titles, deliberately.
   *
   * These two strings used to be a real task title and a real transcription
   * from the session that produced this bug, which baked a piece of the
   * author's own day into a fixture — and from there into the repository.
   * The scenario only needs a garbled title and something to rename it to.
   */
  fresh("the note that came through garbled");
  const reply = await say("rename it to 2pm Budget review");
  check("the rename is an action, not a sentence", reply.outcome?.ok === true, JSON.stringify(reply.outcome));
  check("the effect says what happened", reply.outcome?.effect === "task.updated", String(reply.outcome?.effect));
  check("and the store agrees", titles().join("|") === "2pm Budget review", titles().join("|"));
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
  const lie = 'Done. The task is now titled "2pm Budget review."';
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
/* The noun decides where a thing goes                                 */
/* ------------------------------------------------------------------ */

/**
 * The reported bug, and the rule that answers it.
 *
 * The user said "add tomorrow breakfast to my calendar from 10-10:30 and gym
 * from 10:30 to 11:30 Am and shower from 11:30 to 12:30" and was told "the
 * action isn't firing". Nothing was broken mechanically — the sentence simply
 * matched no intent, because `handleEvent` recognised scheduling *verbs* and
 * never looked at the word "calendar" in it. The model, asked to voice a turn
 * with no action behind it, invented an explanation, which is the same class of
 * failure `claims.ts` exists for.
 *
 * The rule is the one the user stated: the noun they name decides the
 * destination. "to my calendar" books an event; "to my tasks" makes a task.
 */
const destinationOf = async (text: string) => {
  const lifeState = await buildLifeState({ force: true });
  const result = localMind({ text, lifeState });
  const effect = (result?.outcome as { effect?: string } | undefined)?.effect ?? "";
  return {
    where: effect.startsWith("event") ? "calendar" : effect.startsWith("task") || effect.startsWith("reminder") ? "task" : "nothing",
    effect,
    ids: (result?.outcome as { ids?: string[] } | undefined)?.ids?.length ?? 0,
    text: result?.text ?? "",
  };
};

await group("The noun the user named decides the destination", async () => {
  const calendar = await destinationOf("add breakfast to my calendar tomorrow at 10");
  check("to my calendar books an event", calendar.where === "calendar", JSON.stringify(calendar));

  const tasks = await destinationOf("add buy milk to my tasks");
  check("to my tasks makes a task", tasks.where === "task", JSON.stringify(tasks));

  const appointment = await destinationOf("add the dentist appointment to my tasks");
  check("even a word that sounds like a meeting obeys the named destination", appointment.where === "task", JSON.stringify(appointment));

  const asked = await destinationOf("what is on my calendar today");
  check("asking about the calendar does not book anything", asked.where === "nothing", JSON.stringify(asked));
});

await group("A booking verb on its own is still a task", async () => {
  // The comment above `handleEvent` has always claimed this, and the code never
  // did it: "book the flights" fell through every handler to "I didn't follow
  // that." A rule in a comment that the code does not implement is worse than
  // no rule, because the next person reads it and believes it.
  const flights = await destinationOf("book the flights");
  check("book the flights is a task", flights.where === "task", JSON.stringify(flights));

  const meeting = await destinationOf("book a meeting with Sam thursday at 2");
  check("but book a meeting is an event", meeting.where === "calendar", JSON.stringify(meeting));
});

await group("One sentence can book the whole morning", async () => {
  // The store already holds a "breakfast" from the case above, so the entries
  // this group checks are the ones that did not exist before it ran.
  const before = new Set(
    store.eventsBetween("2026-01-01T00:00:00.000Z", "2027-12-31T00:00:00.000Z").map((event) => event.id),
  );

  const reported = await destinationOf(
    "add tomorrow breakfast to my calendar from 10-10:30 and gym from 10:30 to 11:30 Am and shower from 11:30 to 12:30",
  );
  check("the reported sentence creates events", reported.where === "calendar", JSON.stringify(reported));
  check("three of them, not one", reported.ids === 3, `ids=${reported.ids}`);
  check("and it says how many", /3/.test(reported.text), reported.text);

  const drawn = store
    .eventsBetween("2026-01-01T00:00:00.000Z", "2027-12-31T00:00:00.000Z")
    .filter((event) => !before.has(event.id));

  const minutes = (event: { start: string; end: string }) =>
    (new Date(event.end).getTime() - new Date(event.start).getTime()) / 60_000;
  const named = (title: string) => drawn.find((event) => event.title === title);

  check("exactly the three it named", drawn.length === 3, drawn.map((event) => event.title).join(", "));
  const breakfast = named("breakfast");
  const gym = named("gym");
  const shower = named("shower");
  check("breakfast keeps its half hour", breakfast ? minutes(breakfast) === 30 : false, breakfast ? `${minutes(breakfast)}m` : "missing");
  check("the gym keeps its hour", gym ? minutes(gym) === 60 : false, gym ? `${minutes(gym)}m` : "missing");
  check("the shower keeps its hour", shower ? minutes(shower) === 60 : false, shower ? `${minutes(shower)}m` : "missing");
  check("and 10-10:30 was read as ten o'clock", breakfast ? new Date(breakfast.start).getHours() === 10 : false, breakfast ? String(new Date(breakfast.start).getHours()) : "missing");
});

/**
 * The same morning, written as a list with no conjunctions at all.
 *
 * The user's second report — "add the following to my calendar for tomorrow
 * breakfast 10-10:30 am gym 10:30 to 11:30 shower 11:30 to 12:30" — beat the
 * first version of the splitter twice over: "the following" was carried into
 * the title, and the items were separated by nothing but spaces, so only the
 * first range was seen and one event was booked with a title made of the whole
 * line. Both shapes are asserted here because both are how people write.
 */
await group("And when it is a list with no conjunctions", async () => {
  const before = new Set(
    store.eventsBetween("2026-01-01T00:00:00.000Z", "2027-12-31T00:00:00.000Z").map((event) => event.id),
  );

  const listed = await destinationOf(
    "add the following to my calendar for tomorrow breakfast 10-10:30 am gym 10:30 to 11:30 shower 11:30 to 12:30",
  );
  check("the list also creates events", listed.where === "calendar", JSON.stringify(listed));
  check("all three of them", listed.ids === 3, `ids=${listed.ids}`);

  const drawn = store
    .eventsBetween("2026-01-01T00:00:00.000Z", "2027-12-31T00:00:00.000Z")
    .filter((event) => !before.has(event.id));
  const titles = drawn.map((event) => event.title).sort();
  check("with the three names and nothing else", titles.join("|") === "breakfast|gym|shower", titles.join("|"));

  const startMinutes = (event: { start: string }) => {
    const when = new Date(event.start);
    return when.getHours() * 60 + when.getMinutes();
  };
  const starts = drawn.map(startMinutes).sort((a, b) => a - b);
  check("starting at ten, half ten and half eleven", starts.join("|") === "600|630|690", starts.join("|"));
});

await group("A denial of something that did happen", async () => {
  /*
   * The mirror of the guard above, and a real reply.
   *
   * The user asked for three calendar entries and got "That one landed wrong.
   * The parser read your whole line as a single event title … and booked it as
   * one block. It's not three entries." One event *had* been created, so the
   * denial was false and the explanation was invented — a model cannot see a
   * parser, only the ACTION RESULT it is handed.
   */
  const real =
    'That one landed wrong. The parser read your whole line as a single event title - "following for breakfast gym 10:30 to 11:30 shower 11:30 to 12:30" - and booked it as one block at 10:00 AM. It\'s not three entries.';
  check("the real reply is recognised", deniesAnActionThatRan(real));
  check("and the short form too", deniesAnActionThatRan("That didn't go through - nothing was added."));
  check("nothing was created is a denial", deniesAnActionThatRan("Nothing was created. No event."));
  check("no events were created is a denial", deniesAnActionThatRan("No events were created."));

  // It must not fire on a reply that describes a *partial* success honestly -
  // the point is to stop the false denial, not to silence every caveat.
  check("a description of what happened is left alone", !deniesAnActionThatRan("Booked 3 entries for tomorrow."));
  check("and so is a statement about an empty day", !deniesAnActionThatRan("Nothing is scheduled at two, so your afternoon is clear."));
  check("and a clarification about a title", !deniesAnActionThatRan('The title came through as "brkfst", so say the word and I will retitle it.'));
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
