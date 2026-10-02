/**
 * The log: what can be written into it, by hand and out loud.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-health-log.ts
 *
 * WHAT THIS IS REALLY CHECKING
 *
 * The health table was the one part of the app with no door of its own. Sleep,
 * mood, steps and active minutes could only arrive from a phone posting to
 * `/api/health/ingest` or from an Apple Health export in a folder, so the
 * briefing said "sleep unrecorded" over a database that could hold the number
 * perfectly well, and the only answer to "record sleep 7" was "I didn't follow
 * that." This file asserts the door exists and that it opens both ways.
 *
 * Three things it is careful about, because each one is a way this feature could
 * be subtly wrong rather than obviously broken:
 *
 *   1. **A sentence that names mood must not write energy.** "my mood is good"
 *      used to land in the energy column, which meant the mood column stayed
 *      empty forever and the reading was a different quantity from the one the
 *      person reported.
 *   2. **A capture request must not be logged as exercise.** "add a task to walk
 *      for 30 minutes" contains zero of the words a task needs and two of the
 *      words a workout does.
 *   3. **A reading that is taken back must leave nothing behind.** A row with
 *      nothing in it is a day the briefing counts as logged, and the health
 *      table has no trash of its own — so clearing is the entire undo, and it
 *      has to actually delete.
 *
 * And the point of the whole feature, asserted at the end: the number written in
 * the room changes the forecast the briefing shows.
 *
 * It never touches the real database: everything runs against a scratch store in
 * a temp directory, and `setStore` points the side of the app that resolves its
 * own store — the intent engine and the cave operations — at the same one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setStore, XanaStore } from "../src/lib/core/store";
import { buildLifeState } from "../src/lib/context/gateway";
import { localMind } from "../src/lib/mind/local";
import { runCaveOperation, listCaveHealth, CaveError } from "../src/lib/cave/ops";
import { addDays, toDateKey } from "../src/lib/core/time";
import type { HealthSample } from "../src/lib/core/types";

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

function group(title: string, run: () => void | Promise<void>) {
  console.log(`\n${title}\n`);
  return Promise.resolve()
    .then(run)
    .catch((err) => {
      failed += 1;
      console.log(`  FAIL  ${title} threw — ${err instanceof Error ? err.message : String(err)}`);
    });
}

const dir = mkdtempSync(path.join(tmpdir(), "xana-health-log-"));
const store = new XanaStore(path.join(dir, "log.db"));
setStore(store);

const TODAY = toDateKey();
const dayKey = (back: number) => toDateKey(addDays(new Date(), -back));
const rowFor = (date: string): HealthSample | undefined =>
  store.healthSamples(60).find((sample) => sample.date === date);

/** A sentence, answered by the real intent engine against the real life state. */
const say = async (text: string) =>
  localMind({ text, lifeState: await buildLifeState({ force: true }) });

/* ------------------------------------------------------------------ */
/* Said out loud                                                       */
/* ------------------------------------------------------------------ */

await group("Said out loud", async () => {
  const sleep = await say("I slept 7 hours last night");
  check("“I slept 7 hours” writes 7 hours", rowFor(TODAY)?.sleepHours === 7, `got ${rowFor(TODAY)?.sleepHours}`);
  check("and she says the number back", /7h of sleep/.test(sleep.text), sleep.text);

  check(
    "“record sleep 6.5” writes 6.5",
    (await say("record sleep 6.5"), rowFor(TODAY)?.sleepHours === 6.5),
    `got ${rowFor(TODAY)?.sleepHours}`,
  );

  check(
    "“went to bed at 11pm and woke at 7” is eight hours",
    (await say("went to bed at 11pm and woke at 7"), rowFor(TODAY)?.sleepHours === 8),
    `got ${rowFor(TODAY)?.sleepHours}`,
  );

  check(
    "a bad night is a quality, not a number of hours",
    (await say("slept badly"), rowFor(TODAY)?.sleepQuality === 2),
    `got quality=${rowFor(TODAY)?.sleepQuality}`,
  );

  /**
   * The bug this feature exists for. "my mood is good today" was written to the
   * energy column, so the mood column could never be filled by talking and the
   * stored quantity was not the one reported.
   */
  await say("my mood is good today");
  check("“my mood is good” writes mood, not energy", rowFor(TODAY)?.mood === "good", `got mood=${rowFor(TODAY)?.mood}`);
  check("and it leaves energy alone", rowFor(TODAY)?.energy === undefined, `got energy=${rowFor(TODAY)?.energy}`);

  check("“mood: bright” writes bright", (await say("mood: bright"), rowFor(TODAY)?.mood === "bright"));
  check(
    "“not in a great mood” is not read as a good one",
    (await say("not in a great mood"), rowFor(TODAY)?.mood === "low"),
    `got ${rowFor(TODAY)?.mood}`,
  );

  /**
   * The behaviour that must NOT change: a feeling-word without the noun "mood"
   * has always been an energy reading of 1–5, and `check-energy.ts` asserts it.
   * Adding mood must not quietly rewrite sentences that already worked.
   */
  const moodBefore = rowFor(TODAY)?.mood;
  await say("I'm feeling low");
  check(
    "“I'm feeling low” is still an energy reading",
    rowFor(TODAY)?.energy === 2,
    `energy=${rowFor(TODAY)?.energy}`,
  );
  check(
    "and it leaves the mood column alone",
    rowFor(TODAY)?.mood === moodBefore,
    `${moodBefore} -> ${rowFor(TODAY)?.mood}`,
  );

  check("“8,000 steps” writes 8000", (await say("I did 8,000 steps"), rowFor(TODAY)?.steps === 8000), `got ${rowFor(TODAY)?.steps}`);
  check(
    "“45 minutes of yoga” is 45 active minutes",
    (await say("45 minutes of yoga"), rowFor(TODAY)?.activeMinutes === 45),
    `got ${rowFor(TODAY)?.activeMinutes}`,
  );

  const merged = rowFor(TODAY);
  check(
    "a second sentence adds to the day rather than replacing it",
    merged?.sleepHours === 8 &&
      merged?.sleepQuality === 2 &&
      merged?.mood === "low" &&
      merged?.energy === 2 &&
      merged?.steps === 8000 &&
      merged?.activeMinutes === 45,
    JSON.stringify(merged),
  );
});

/* ------------------------------------------------------------------ */
/* What it refuses                                                     */
/* ------------------------------------------------------------------ */

await group("What it refuses", async () => {
  const before = JSON.stringify(store.healthSamples(60));
  const question = await say("how did I sleep?");
  check("a question is not a report", JSON.stringify(store.healthSamples(60)) === before, question.text);

  /**
   * The most frustrating failure in the app: asking for a field the database
   * has, and being told the request made no sense. It gets an answer that says
   * what a number looks like instead.
   */
  const bare = await say("log sleep");
  check("“log sleep” asks for the hours instead of shrugging", /how many hours/i.test(bare.text), bare.text);
  check("and still writes nothing", JSON.stringify(store.healthSamples(60)) === before);

  /**
   * The collision that matters: a capture request has no noun this parser can
   * see and two verbs it can. A health handler that runs before the task handler
   * would swallow the task.
   */
  const capture = await say("add a task to walk for 30 minutes");
  check("a task to walk is a task, not exercise", capture.outcome?.effect === "task.created", capture.outcome?.effect);
  check(
    "and it wrote no active minutes",
    rowFor(TODAY)?.activeMinutes === 45,
    `got ${rowFor(TODAY)?.activeMinutes}`,
  );

  await say("start a 45 minute focus session on the parser");
  check(
    "a focus session is not exercise either",
    rowFor(TODAY)?.activeMinutes === 45,
    `got ${rowFor(TODAY)?.activeMinutes}`,
  );
});

/* ------------------------------------------------------------------ */
/* Written by hand                                                     */
/* ------------------------------------------------------------------ */

await group("Written by hand", async () => {
  const yesterday = dayKey(1);

  runCaveOperation("health.log", { date: yesterday, field: "sleepHours", value: 6.25 });
  /**
   * A tenth of an hour is six minutes, and that is the resolution a person
   * actually knows their own night to. Asserted rather than left implicit: the
   * value typed into the field is not always the value stored in the row.
   */
  check("a reading is kept to a tenth of an hour", rowFor(yesterday)?.sleepHours === 6.3, `got ${rowFor(yesterday)?.sleepHours}`);

  runCaveOperation("health.log", { date: yesterday, field: "mood", value: "flat" });
  runCaveOperation("health.log", { date: yesterday, field: "activeMinutes", value: 25 });
  const day = rowFor(yesterday);
  check(
    "each writing lands beside the others",
    day?.sleepHours === 6.3 && day?.mood === "flat" && day?.activeMinutes === 25,
    JSON.stringify(day),
  );
  check("and it is marked as the user's own", day?.source === "user", `source=${day?.source}`);

  check(
    "a value outside what a day can hold is refused, not clamped",
    throwsCaveError(() => runCaveOperation("health.log", { date: yesterday, field: "sleepHours", value: 30 })) &&
      rowFor(yesterday)?.sleepHours === 6.3,
  );
  check(
    "an unknown field cannot write a column",
    throwsCaveError(() => runCaveOperation("health.log", { date: yesterday, field: "source", value: "phone" })) &&
      rowFor(yesterday)?.source === "user",
  );
  check(
    "the count of meals is not settable by hand",
    throwsCaveError(() => runCaveOperation("health.log", { date: yesterday, field: "meals", value: 3 })) &&
      rowFor(yesterday)?.meals === undefined,
  );
  check(
    "tomorrow cannot be written",
    throwsCaveError(() => runCaveOperation("health.log", { date: dayKey(-1), field: "steps", value: 10 })),
  );

  /**
   * A phone posting one number must not wipe the rest of the day: the upsert
   * treats a missing field as "untouched", and `meal_names` in particular has to
   * survive a body that never heard of it.
   */
  runCaveOperation("health.meal", { date: yesterday, meal: "lunch" });
  store.upsertHealth({ date: yesterday, steps: 5000, source: "phone" });
  const merged = rowFor(yesterday);
  check(
    "a phone's partial day merges instead of replacing",
    merged?.steps === 5000 && merged?.sleepHours === 6.3 && merged?.meals === 1,
    JSON.stringify(merged),
  );
});

/* ------------------------------------------------------------------ */
/* The count follows the names                                         */
/* ------------------------------------------------------------------ */

await group("The count follows the names", async () => {
  const date = dayKey(2);
  const meals = () => rowFor(date);

  runCaveOperation("health.meal", { date, meal: "lunch" });
  check("ticking lunch logs one meal", meals()?.meals === 1 && meals()?.mealsLogged?.join() === "lunch", JSON.stringify(meals()));

  runCaveOperation("health.meal", { date, meal: "breakfast" });
  check(
    "and it knows which one, which a count could not",
    meals()?.meals === 2 && meals()?.mealsLogged?.join() === "lunch,breakfast",
    JSON.stringify(meals()),
  );

  runCaveOperation("health.meal", { date, meal: "snack" });
  check(
    "a snack is noted and is not one of the three",
    meals()?.meals === 2 && meals()?.mealsLogged?.includes("snack") === true,
    JSON.stringify(meals()),
  );

  runCaveOperation("health.meal", { date, meal: "lunch", on: false });
  check("unticking one takes it off", meals()?.mealsLogged?.join() === "breakfast,snack", JSON.stringify(meals()));

  /**
   * The same sentence twice is one meal. Before the names existed the counter
   * simply went up, so saying "log lunch" twice read "2 of 3".
   *
   * A sentence always writes *today* — the executor's `toDateKey()` is the only
   * day it knows — so this section reads today's row, not a day of its own.
   */
  await say("log lunch");
  const first = rowFor(TODAY);
  check("a spoken meal is named", first?.mealsLogged?.join() === "lunch", JSON.stringify(first));
  check("spoken twice is not eaten twice", (await say("log lunch"), rowFor(TODAY)?.meals === 1), `got ${rowFor(TODAY)?.meals}`);
  check("and she says so", /already logged/i.test((await say("log lunch")).text));
  check(
    "the count and the names agree",
    rowFor(TODAY)?.meals === (rowFor(TODAY)?.mealsLogged ?? []).filter((name) => name !== "snack").length,
    JSON.stringify(rowFor(TODAY)),
  );
});

/* ------------------------------------------------------------------ */
/* Taking it back                                                      */
/* ------------------------------------------------------------------ */

await group("Taking it back", async () => {
  const date = dayKey(4);
  runCaveOperation("health.log", { date, field: "sleepHours", value: 5 });
  runCaveOperation("health.log", { date, field: "mood", value: "low" });

  const cleared = runCaveOperation("health.clear", { date, field: "sleepHours" });
  check("clearing one reading leaves the other", rowFor(date)?.sleepHours === undefined && rowFor(date)?.mood === "low");
  check(
    "the operation answers with the day as it now stands",
    cleared.day?.sleepHours === undefined && cleared.day?.mood === "low",
    JSON.stringify(cleared.day),
  );

  runCaveOperation("health.clear", { date, field: "mood" });
  /**
   * Not "a row with nothing in it". An empty row is a day the briefing counts as
   * logged, `lastHealthSource` would report it as the newest day from the user,
   * and the memory ingest would take it for a day of data.
   */
  check("clearing the last reading removes the day", rowFor(date) === undefined, JSON.stringify(rowFor(date)));

  const mealsDay = dayKey(5);
  runCaveOperation("health.meal", { date: mealsDay, meal: "dinner" });
  runCaveOperation("health.clear", { date: mealsDay, field: "meals" });
  check(
    "clearing meals takes the names with it",
    rowFor(mealsDay) === undefined,
    JSON.stringify(rowFor(mealsDay)),
  );

  const untickDay = dayKey(6);
  runCaveOperation("health.meal", { date: untickDay, meal: "breakfast" });
  runCaveOperation("health.meal", { date: untickDay, meal: "breakfast", on: false });
  check("unticking the only meal leaves no row behind", rowFor(untickDay) === undefined);
});

/* ------------------------------------------------------------------ */
/* The week the room shows                                             */
/* ------------------------------------------------------------------ */

await group("The week the room shows", () => {
  const log = listCaveHealth();
  check("the window is seven days", log.windowDays === 7, `got ${log.windowDays}`);
  check("today is the last day it can hold", log.today === TODAY);

  const dates = log.days.map((sample) => sample.date);
  check("days come back oldest first", [...dates].sort().join() === dates.join(), dates.join());
  check("nothing older than the window", dates.every((date) => date >= dayKey(6)), dates.join());
  check("and yesterday's reading is in it", dates.includes(dayKey(1)));

  /** The API is not limited to the window even though the room is. */
  const old = dayKey(30);
  runCaveOperation("health.log", { date: old, field: "steps", value: 1234 });
  check("a day older than the window can still be written", rowFor(old)?.steps === 1234);
  check(
    "but it does not appear in the room",
    !listCaveHealth().days.some((sample) => sample.date === old),
  );
});

/* ------------------------------------------------------------------ */
/* The forecast reads it                                               */
/* ------------------------------------------------------------------ */

await group("The forecast reads it", async () => {
  const date = TODAY;

  runCaveOperation("health.clear", { date, field: "sleepHours" });
  runCaveOperation("health.log", { date, field: "sleepHours", value: 4 });
  const short = await buildLifeState({ force: true });
  const shortScore = short.energy.score;

  runCaveOperation("health.log", { date, field: "sleepHours", value: 8.5 });
  const full = await buildLifeState({ force: true });

  check("the briefing sees the hours", full.health.latest?.sleepHours === 8.5, `got ${full.health.latest?.sleepHours}`);
  check(
    "the seven-day average is computed from it",
    full.health.sleepAvgHours !== undefined,
    `avg=${full.health.sleepAvgHours}`,
  );
  check(
    "a full night reads better than a short one",
    full.energy.score > shortScore,
    `4h=${shortScore} 8.5h=${full.energy.score}`,
  );
  check(
    "a short night is named in the forecast's own note",
    /You slept 4\.0h/.test(short.energy.note ?? ""),
    short.energy.note,
  );
});

/* ------------------------------------------------------------------ */

function throwsCaveError(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch (err) {
    return err instanceof CaveError;
  }
}

/**
 * The store holds the file open, and Windows will not remove a directory whose
 * files are still open — so the close comes first, and a failure to clean up a
 * temp directory is not a failed check.
 */
store.close();
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* the OS will take it */
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
