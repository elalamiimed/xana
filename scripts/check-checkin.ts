/**
 * The check-in: does she speak first, and does she stop when she should?
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-checkin.ts
 *
 * WHAT THIS PROVES, AND WHY THESE CASES
 *
 * `derived/proactive.ts` already has a suite for the utility arithmetic. This one
 * covers the half that suite cannot: the *pass* - what it decides to say, what it
 * refuses to repeat, and how it spends a budget that has to survive a restart.
 *
 * The negative cases carry the weight. An assistant that says something useful
 * once is easy; the failure that makes people turn one off is saying the same
 * thing four times, and that failure is invisible in a single-pass test. So the
 * budget, the dedupe and the day boundary are each driven twice.
 *
 * OFFLINE, and against a scratch database. The real `data/xana.db` is never
 * opened - it holds a real person's calendar.
 */

import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

const PROJECT_ROOT = process.cwd();
const REAL_DB = path.join(PROJECT_ROOT, "data", "xana.db");
const realBefore = existsSync(REAL_DB) ? statSync(REAL_DB) : undefined;

const dir = mkdtempSync(path.join(tmpdir(), "xana-checkin-"));
process.env.XANA_DATA_DIR = dir;

const { XanaStore } = await import("../src/lib/core/store");
const { runCheckIn, dedupeKeyFor, candidatesFrom } = await import("../src/lib/derived/checkin");

const store = new XanaStore(path.join(dir, "xana.db"));

/* ------------------------------------------------------------------ */
/* A life state built by hand, so no adapter is consulted.             */
/* ------------------------------------------------------------------ */

function stateWith(overrides: {
  overdue?: Array<{ id: string; title: string; due: string }>;
  nudges?: Array<{ id: string; tone: string; text: string; priority: number }>;
  goals?: Array<{ title: string; pace: string; note: string }>;
  habits?: Array<{ name: string; thisWeek: number; targetPerWeek: number; streak: number; atRisk: boolean }>;
  eventsToday?: Array<{ title: string; start: string; end: string }>;
}): never {
  const now = new Date(2026, 9, 10, 9, 0, 0);
  return {
    generatedAt: now.toISOString(),
    partOfDay: "morning",
    headline: "",
    energy: { score: 70, band: "sharp", note: "", windows: [] },
    calendar: { today: overrides.eventsToday ?? [], next: undefined, freeMinutes: 120 },
    tasks: {
      openCount: (overrides.overdue ?? []).length,
      completedThisWeek: 0,
      overdue: overrides.overdue ?? [],
      focus: [],
    },
    habits: (overrides.habits ?? []).map((h, i) => ({ id: `h${i}`, ...h })),
    goals: (overrides.goals ?? []).map((g, i) => ({
      goal: { id: `g${i}`, title: g.title, horizon: "mid" },
      progress: { pace: g.pace, note: g.note, progress: 0.2 },
    })),
    health: { latest: undefined, sleepAvgHours: undefined, sleepDebtHours: 0, moodTrend: [] },
    memory: [],
    patterns: [],
    nudges: (overrides.nudges ?? []).map((n) => ({ ...n, tone: n.tone as "warn" })),
    finance: [],
    mail: [],
    sources: [],
  } as never;
}

const MORNING = new Date(2026, 9, 10, 9, 0, 0);

/* ------------------------------------------------------------------ */
console.log("\nWhat reaching the pass requires\n");

const busy = stateWith({
  overdue: [{ id: "t1", title: "Review hack hive applications", due: "2026-10-07" }],
  nudges: [{ id: "n1", tone: "warn", text: "Stand-up starts in 20 minutes.", priority: 5 }],
  goals: [{ title: "Run the spring half marathon", pace: "stalled", note: "Last movement 23 days ago." }],
  habits: [{ name: "Meditation", thisWeek: 2, targetPerWeek: 5, streak: 4, atRisk: true }],
});

const candidates = candidatesFrom(busy, MORNING);
console.log(`    ${candidates.length} candidates from one life state`);
check("an overdue task becomes a candidate", candidates.some((c) => c.text.includes("hack hive")));
check("a stalled goal becomes a candidate", candidates.some((c) => c.text.includes("half marathon")));
check("a habit at risk becomes a candidate", candidates.some((c) => c.text.includes("Meditation")));
check("and the app's own nudge is carried through", candidates.some((c) => c.text.includes("Stand-up")));

const nothing = stateWith({});
check("an empty life state yields nothing to say", candidatesFrom(nothing, MORNING).length === 0);

const onTrack = stateWith({ goals: [{ title: "Ship the parser", pace: "on-track", note: "Tracking to plan." }] });
check(
  "a goal that is on track is not a candidate",
  candidatesFrom(onTrack, MORNING).length === 0,
  "only stalled and slipping goals are worth raising",
);

const safeHabit = stateWith({ habits: [{ name: "Reading", thisWeek: 4, targetPerWeek: 5, streak: 2, atRisk: false }] });
check("a habit that is not at risk is not a candidate", candidatesFrom(safeHabit, MORNING).length === 0);

/* ------------------------------------------------------------------ */
console.log("\nThe budget: she says a few things, then stops\n");

const first = runCheckIn(busy, { now: MORNING, store });
console.log(`    pass 1: ${first.deliver.length} delivered, ${first.spentToday}/${first.budgetPerDay} spent before`);
for (const d of first.deliver) console.log(`      [${d.utility}] ${d.text}`);

check("a fresh day delivers something", first.deliver.length > 0);
check("and never more than the budget", first.deliver.length <= first.budgetPerDay, String(first.deliver.length));

const second = runCheckIn(busy, { now: MORNING, store });
console.log(`    pass 2: ${second.deliver.length} delivered, ${second.spentToday}/${second.budgetPerDay} spent before`);
check("the second pass within the budget says nothing new", second.deliver.length === 0, JSON.stringify(second.deliver));
check("and it reports the budget as spent", second.spentToday >= first.deliver.length, String(second.spentToday));
check(
  "with 'already said today' as the reason, not 'not worth it'",
  second.considered.some((c) => c.reason === "already said today"),
  second.considered.map((c) => c.reason).join(" | "),
);

/* Raised budget: the rest comes through, and NOTHING repeats. This is the
 * assertion that matters - a budget implemented as "count what I said" without
 * dedupe would re-announce the same three things. */
const raised = runCheckIn(busy, { now: MORNING, store, budgetPerDay: 9 });
console.log(`    pass 3 (budget 9): ${raised.deliver.length} delivered`);
for (const d of raised.deliver) console.log(`      [${d.utility}] ${d.text}`);
check(
  "a raised budget does not repeat what was already said",
  raised.deliver.every((d) => !first.deliver.some((f) => f.text === d.text)),
  JSON.stringify(raised.deliver.map((d) => d.text)),
);

/* A zero budget is a legitimate "what would you say" and must record nothing. */
const asked = runCheckIn(busy, { now: MORNING, store, budgetPerDay: 0, dryRun: true });
check("a zero budget delivers nothing", asked.deliver.length === 0);
check("and still reports what it considered", asked.considered.length > 0);

/* A dry run must not spend the budget. */
const dryStore = new XanaStore(path.join(dir, "dry.db"));
const dry = runCheckIn(busy, { now: MORNING, store: dryStore, dryRun: true });
check("a dry run delivers something", dry.deliver.length > 0);
check("but records nothing", dryStore.proactiveToday(dry.day).length === 0, String(dryStore.proactiveToday(dry.day).length));
const afterDry = runCheckIn(busy, { now: MORNING, store: dryStore });
check("so the real pass afterwards still has a full budget", afterDry.deliver.length === dry.deliver.length);

/* ------------------------------------------------------------------ */
console.log("\nDays, and the boundary between them\n");

const tomorrow = new Date(2026, 9, 11, 9, 0, 0);
const nextDay = runCheckIn(busy, { now: tomorrow, store });
check("a new day starts with a fresh budget", nextDay.spentToday === 0, String(nextDay.spentToday));
check("and the same things are worth saying again", nextDay.deliver.length > 0);
check("under a different date key", nextDay.day !== first.day, `${first.day} vs ${nextDay.day}`);

/* The day is Beijing's. A UTC day boundary would hand her a second budget at
 * 08:00 local, which is exactly when the morning pass runs. */
const lateNight = new Date(2026, 9, 10, 23, 30, 0);
const late = runCheckIn(busy, { now: lateNight, store: new XanaStore(path.join(dir, "late.db")) });
check("23:30 local is still the same calendar day", late.day === "2026-10-10", late.day);

/* ------------------------------------------------------------------ */
console.log("\nQuiet hours, a meeting, and a spent budget\n");

const night = new Date(2026, 9, 10, 3, 0, 0);
const quiet = runCheckIn(busy, { now: night, store: new XanaStore(path.join(dir, "q.db")) });
check("nothing is delivered at 03:00", quiet.deliver.length === 0);
check("and the reason says so", quiet.considered.some((c) => /quiet hours/.test(c.reason)), quiet.considered[0]?.reason);
check("while still reporting what it would have said", quiet.considered.length > 0);

const inMeeting = stateWith({
  overdue: [{ id: "t1", title: "Something overdue", due: "2026-10-01" }],
  eventsToday: [
    {
      title: "OOP LAB",
      start: new Date(2026, 9, 10, 8, 30).toISOString(),
      end: new Date(2026, 9, 10, 10, 30).toISOString(),
    },
  ],
});
const during = runCheckIn(inMeeting, { now: MORNING, store: new XanaStore(path.join(dir, "m.db")) });
check("nothing is delivered during a meeting", during.deliver.length === 0, JSON.stringify(during.deliver));
check("and the reason names the meeting", during.considered.some((c) => /meeting/.test(c.reason)), during.considered[0]?.reason);

/* ------------------------------------------------------------------ */
console.log("\nThe dedupe key\n");

check("the same sentence keys the same", dedupeKeyFor("Stand-up in 20 minutes.") === dedupeKeyFor("Stand-up in 20 minutes."));
check("whitespace does not make it new", dedupeKeyFor("Hello   world") === dedupeKeyFor("hello world"));
check("case does not make it new", dedupeKeyFor("Hello World") === dedupeKeyFor("hello world"));
check("different sentences differ", dedupeKeyFor("One thing") !== dedupeKeyFor("Another thing"));
check("an empty string still keys", dedupeKeyFor("").length > 1);

/* ------------------------------------------------------------------ */
console.log("\nThe log the budget reads\n");

const logStore = new XanaStore(path.join(dir, "log.db"));
const wrote = logStore.logProactive({ kind: "nudge", dedupeKey: "k1", text: "one", utility: 0.5, day: "2026-10-10" });
check("a first write reports success", wrote === true);
const again = logStore.logProactive({ kind: "nudge", dedupeKey: "k1", text: "one", utility: 0.5, day: "2026-10-10" });
check("a duplicate write reports failure", again === false);
check("and only one row exists", logStore.proactiveToday("2026-10-10").length === 1);
const otherDay = logStore.logProactive({ kind: "nudge", dedupeKey: "k1", text: "one", utility: 0.5, day: "2026-10-11" });
check("the same key on another day is a new row", otherDay === true);
check("and the two days are counted separately", logStore.proactiveToday("2026-10-11").length === 1);

/* ------------------------------------------------------------------ */
console.log("\nThe pass never touches the real database\n");

if (realBefore) {
  const realAfter = statSync(REAL_DB);
  check("its size is unchanged", realAfter.size === realBefore.size, `${realBefore.size} -> ${realAfter.size}`);
  check("its mtime is unchanged", realAfter.mtimeMs === realBefore.mtimeMs);
} else {
  check("there was no real database to protect", true);
}
check("and this suite ran against a temp directory", process.env.XANA_DATA_DIR === dir, String(process.env.XANA_DATA_DIR));

store.close();
dryStore.close();
logStore.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;

export {};
