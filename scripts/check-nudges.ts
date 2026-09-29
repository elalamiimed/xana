/**
 * Do the nudges respond to the data, or only to the digits?
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-nudges.ts
 *
 * The failure this guards against is subtle and was everywhere in this file:
 * a line that interpolates a value looks dynamic and reads as dynamic, while
 * the *phrasing* around it never changes. "Meditation is at 26 days. Log it
 * and it holds." was the same sentence for a three-day streak and for the
 * longest run of the user's life.
 *
 * So the assertions below are on the words with the digits stripped out. The
 * digits always varied; that was never the question.
 */

import { buildNudges } from "../src/lib/derived/nudges";

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

/** The wording, with every number removed. */
const words = (text: string) => text.replace(/[0-9.,%]+/g, "").replace(/\s+/g, " ").trim();

const now = new Date(new Date().setHours(14, 0, 0, 0));

const habit = (streak: number, thisWeek: number, longest = streak) =>
  ({
    id: `h${streak}-${thisWeek}`,
    name: "Meditation",
    targetPerWeek: 7,
    thisWeek,
    streak,
    longestStreak: longest,
    atRisk: true,
    onPace: false,
    completions: [],
  }) as never;

const base = {
  tasks: [],
  events: [],
  habits: [],
  goals: [],
  health: [],
  mail: [],
  patterns: [],
  freeMinutes: 0,
  now,
};

const run = (overrides: Record<string, unknown>) =>
  buildNudges({ ...base, ...overrides } as never);

const textOf = (overrides: Record<string, unknown>, match: RegExp) =>
  run(overrides).find((n) => match.test(n.text))?.text ?? "";

console.log("\nStreaks\n");

// The streak lines lowercase the habit name mid-sentence, so the finder has to
// be case-insensitive — a case-sensitive match here found the energy check-in
// instead and reported an empty string.
const threeDay = textOf({ habits: [habit(3, 2)] }, /meditation/i);
const longest = textOf({ habits: [habit(40, 2, 40)] }, /meditation/i);
const oneAway = textOf({ habits: [habit(12, 6)] }, /meditation/i);

check("a streak nudge is produced", threeDay.length > 0, threeDay);
check(
  "a 3-day streak and a record run are described differently",
  words(threeDay) !== words(longest),
  `"${words(threeDay)}" vs "${words(longest)}"`,
);
check("a record run is named as the record", /longest/i.test(longest), longest);
check(
  "a week one log from holding says so",
  /one .* today/i.test(oneAway),
  `got: "${oneAway}"`,
);

console.log("\nSleep debt\n");

const debt = (hours: number) =>
  textOf(
    { health: Array.from({ length: 7 }, (_, i) => ({ date: `d${i}`, sleepHours: hours, source: "s" })) },
    /debt|down this week/i,
  );

const small = debt(6.6);
const large = debt(4.0);
check("a small debt is reported", small.length > 0, small);
check("a large debt is reported", large.length > 0, large);
check(
  "a fortnight of debt is not given the same sentence as a bad week",
  words(small) !== words(large),
  `"${words(small)}" vs "${words(large)}"`,
);

console.log("\nFree time\n");

const free = (minutes: number) =>
  textOf({ freeMinutes: minutes, events: [{ id: "e", title: "x", start: new Date().toISOString(), end: new Date().toISOString(), source: "local" }] }, /unscheduled|free|between/i);

const short = free(100);
const long = free(300);
check("ninety minutes is reported", short.length > 0, short);
check("five hours is reported", long.length > 0, long);
check(
  "a gap between things reads differently from a free afternoon",
  words(short) !== words(long),
  `"${words(short)}" vs "${words(long)}"`,
);

console.log("\nWeather is a reading, not an instruction\n");

const weather = (over: Record<string, unknown>) =>
  textOf({ weather: { location: "Shenzhen", synthetic: false, ...over } }, /rain|swing|cold|°|chance/i);

const rain = weather({ precipitationChance: 0.6, highC: 24, lowC: 20, temperatureC: 22, condition: "cloudy" });
const drizzle = weather({ precipitationChance: 0.85, highC: 24, lowC: 20, temperatureC: 22, condition: "rain" });
const swing = weather({ precipitationChance: 0.1, highC: 28, lowC: 12, temperatureC: 20, condition: "clear" });

check("rain is reported", /rain/i.test(rain), rain);
check("a heavy chance and a light one differ", words(rain) !== words(drizzle), `"${rain}" vs "${drizzle}"`);
check("a temperature swing is reported", /swing/i.test(swing), swing);
check(
  "no weather nudge issues an instruction",
  ![rain, drizzle, swing].some((t) => /\b(take|wear|bring|layers)\b/i.test(t)),
  JSON.stringify([rain, drizzle, swing]),
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
