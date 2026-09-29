/**
 * The energy reading: parsing, persistence, and what the briefing does with it.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-energy.ts
 *
 * The interesting failure here is not "did it save". It is the two ways a
 * reading can be wrong without anyone noticing:
 *
 *   1. **Swallowing a question.** "how's my energy" and "energy 3" arrive
 *      through the same word. If the parser treats a question as a report it
 *      silently writes a number the user never gave, and the briefing then
 *      shows them a figure they will not recognise.
 *   2. **Losing the reading to an import.** `health_samples` is keyed by day
 *      and the sleep/health adapters write to the same row, so a reading has
 *      to survive them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setStore, XanaStore } from "../src/lib/core/store";
import { buildLifeState, invalidateContext } from "../src/lib/context/gateway";
import { localMind } from "../src/lib/mind/local";
import { toDateKey } from "../src/lib/core/time";

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

const dir = mkdtempSync(path.join(tmpdir(), "xana-energy-"));
const store = new XanaStore(path.join(dir, "energy.db"));
setStore(store);

/** `buildLifeState` is async, and every write invalidates it, so: per call. */
const say = async (text: string) =>
  localMind({ text, lifeState: await buildLifeState({ force: true }) });

const stored = () => store.healthSamples(1)[0];

console.log("\nWhat she hears\n");

/* ---- a question must not become a report ---------------------------- */

const question = await say("how's my energy");
check(
  "a question about energy does not write a reading",
  stored()?.energy === undefined,
  `stored energy=${stored()?.energy}`,
);
check(
  "and it answers with the forecast instead",
  (question.cards ?? []).some((c) => c.kind === "energy"),
);

/* ---- phrasing the user would actually type --------------------------- */

const reports: Array<[string, number]> = [
  ["energy 3", 3],
  ["my energy is 4", 4],
  ["energy: 2", 2],
  ["energy level 5", 5],
  ["my energy is at 2", 2],
  ["I'm at 5 today", 5],
  ["feeling a 4", 4],
  ["rating 2/5", 2],
  ["I'm exhausted", 1],
  ["feeling sharp", 4],
  ["a bit sluggish", 2],
  ["steady", 3],
];

for (const [utterance, expected] of reports) {
  const out = await say(utterance);
  check(
    `"${utterance}" records ${expected}`,
    stored()?.energy === expected && out.outcome?.effect === "energy.logged",
    `stored=${stored()?.energy} effect=${out.outcome?.effect}`,
  );
}

/* ---- numbers that are not energy levels ------------------------------ */

console.log("\nNumbers that are not energy levels\n");

for (const utterance of [
  "remind me to call Mom at 3",
  "add a task to review the deck at 4",
  "note that the plumber quoted 340",
]) {
  const before = stored()?.energy;
  await say(utterance);
  check(`"${utterance}" is not read as a level`, before === stored()?.energy, `${before} -> ${stored()?.energy}`);
}

/* ---- persistence and the briefing ------------------------------------ */

console.log("\nPersistence and the briefing\n");

await say("energy 3");
const today = toDateKey();
store.upsertHealth({ date: today, sleepHours: 7.4, source: "seed" });
check(
  "a health import does not erase the reading",
  stored()?.energy === 3,
  `energy=${stored()?.energy}`,
);
check(
  "and the import's own field still lands",
  stored()?.sleepHours === 7.4,
  `sleep=${stored()?.sleepHours}`,
);

await say("energy 2");
const state = await buildLifeState({ force: true });
const card = localMind({ text: "brief me", lifeState: state }).cards?.find(
  (c) => c.kind === "briefing",
);
const energy =
  card && card.kind === "briefing"
    ? card.sections.find((s) => s.kind === "energy")
    : undefined;

check(
  "the briefing shows the reading the user gave",
  Boolean(energy && energy.kind === "energy" && energy.reading?.level === 2),
  JSON.stringify(energy),
);
check(
  "and it is not stale, because it was just given",
  Boolean(energy && energy.kind === "energy" && energy.stale === false),
);
check(
  "the forecast is still reported separately",
  Boolean(energy && energy.kind === "energy" && typeof energy.forecast.score === "number"),
);

const reply = await say("energy 2");
check(
  "the reply carries the level the user gave",
  reply.outcome?.message.includes("2/5") === true,
  reply.outcome?.message,
);

/* ---- the note says what the number cannot ---------------------------- */

console.log("\nThe forecast note\n");

const { energyForecast } = await import("../src/lib/derived/energy");

const event = (startHour: number, hours: number) => {
  const start = new Date(new Date().setHours(startHour, 0, 0, 0));
  const end = new Date(start.getTime() + hours * 3_600_000);
  return { id: "e", title: "Block", start: start.toISOString(), end: end.toISOString(), source: "local" };
};

const forecastAt = (hour: number, opts: { sleep?: number; events?: unknown[]; debt?: number } = {}) =>
  energyForecast({
    health: Array.from({ length: opts.debt ? 6 : 1 }, (_, i) => ({
      date: toDateKey(new Date(Date.now() - i * 86_400_000)),
      sleepHours: opts.sleep ?? 7.6,
      source: "seed",
    })),
    events: (opts.events ?? []) as never,
    tasks: [],
    focus: [],
    now: new Date(new Date().setHours(hour, 0, 0, 0)),
  });

const morning = forecastAt(8, { sleep: 7.6, events: [event(14, 3)] });
const cramped = forecastAt(9, { sleep: 5.2, events: [event(9, 4), event(14, 3)] });
const empty = forecastAt(8, { sleep: 7.8, events: [] });

check("a note is always produced", [morning, cramped, empty].every((f) => f.note.length > 0));
check(
  "a short night is named rather than described as a band",
  /5\.2h/.test(cramped.note),
  cramped.note,
);check(
  "the same band at different hours does not read identically",
  morning.note !== forecastAt(20, { sleep: 7.6, events: [event(14, 3)] }).note,
  `08:00="${morning.note}" 20:00="${forecastAt(20, { sleep: 7.6, events: [event(14, 3)] }).note}"`,
);
// A morning at peak with a clear afternoon: the useful thing to say is that
// the strength is now, not later. What matters is that it is a statement about
// the shape of the day rather than a label already printed beside the number.
const peakNow = forecastAt(8, { sleep: 7.6, events: [event(14, 3)] });
check(
  "a peak morning says the strength is now",
  /now is the strong stretch/i.test(peakNow.note),
  peakNow.note,
);

// A low morning with nothing better coming: the honest answer is that today
// will not improve, which is more useful than naming the cause and stopping.
// An earlier version of this function did exactly that — a short night
// produced the note "On 5.5h." and said nothing about the day.
const lowMorning = forecastAt(6, { sleep: 5.5, events: [event(14, 3)] });
check(
  "a slow start with no relief says so",
  /no better stretch is coming/i.test(lowMorning.note),
  lowMorning.note,
);
check(
  "and the cause is still named alongside it",
  /slept 5\.5h/i.test(lowMorning.note),
  lowMorning.note,
);

// A good night with a stronger morning ahead: the useful thing is the lift.
const lifts = forecastAt(6, { sleep: 7.6, events: [event(14, 3)] });
check(
  "a morning that improves points at the stretch that is coming",
  /lifts through|strongest stretch/i.test(lifts.note),
  lifts.note,
);
check(
  "and that is a different sentence from the peak morning",
  lifts.note !== peakNow.note,
  `"${lifts.note}" vs "${peakNow.note}"`,
);
check(
  "an empty day is not given advice it cannot support",
  empty.note.length < 60,
  empty.note,
);
check(
  "the band alone is not the whole note when there is more to say",
  morning.note !== "A maintenance day." && morning.note !== "Strong day.",
  morning.note,
);

/* ---- the twice-daily ask --------------------------------------------- */

console.log("\nAsking for it, twice a day\n");

const { buildNudges } = await import("../src/lib/derived/nudges");

/** A state with only what the check-in reads. */
const nudgeInput = (energyAt: string | undefined, hour: number) => ({
  tasks: [],
  events: [],
  habits: [],
  goals: [],
  health: energyAt
    ? [{ date: toDateKey(), energy: 3, energyAt, source: "user" }]
    : [],
  mail: [],
  patterns: [],
  freeMinutes: 0,
  now: new Date(new Date().setHours(hour, 0, 0, 0)),
});

const asksAt = (energyAt: string | undefined, hour: number) =>
  buildNudges(nudgeInput(energyAt, hour)).some((n) => /A number, 1 to 5/.test(n.text));

/** A reading taken `hours` before the hour being asked about. */
const readingAgo = (hour: number, hours: number) => {
  const at = new Date(new Date().setHours(hour, 0, 0, 0));
  return new Date(at.getTime() - hours * 3_600_000).toISOString();
};

check("06:00 is too early to ask", asksAt(undefined, 6) === false);
check("14:00 asks when nothing has been reported", asksAt(undefined, 14) === true);
check("20:00 asks again in the evening", asksAt(undefined, 20) === true);
check("16:00 is a gap between the two, so it stays quiet", asksAt(undefined, 16) === false);

check("a reading an hour old is left alone", asksAt(readingAgo(20, 1), 20) === false);
check("a reading six hours old is still left alone", asksAt(readingAgo(20, 6), 20) === false);
check(
  "a reading from this morning is asked about again",
  asksAt(readingAgo(20, 9), 20) === true,
);

store.close();
rmSync(dir, { recursive: true, force: true });
invalidateContext();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
