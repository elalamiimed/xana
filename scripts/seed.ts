/**
 * Seed Xana with a plausible life.
 *
 * This is not lorem ipsum. The data is shaped so the derived layer actually has
 * something to find, which is what makes the assistant demonstrable:
 *
 *  - Deep work clusters on Tuesdays and Thursdays  -> "deep-work-tuesday"
 *  - Short nights are followed by flat mood        -> "sleep-mood-coupling"
 *  - Meditation has a long streak that is at risk  -> habit nudge
 *  - One goal has stalled for weeks                -> "goal-stalled-*"
 *  - A dense meeting day                           -> "calendar-crowding"
 *
 * Deterministic: a seeded PRNG, and all dates are relative to today, so the
 * demo is coherent whenever it is run.
 *
 *   npm run seed          # add the demo life (skips if already seeded)
 *   npm run seed -- --reset   # wipe and rebuild
 */

import { existsSync, rmSync } from "node:fs";
import { XanaStore, defaultDbPath } from "../src/lib/core/store";
import type { HealthSample, MoodLabel } from "../src/lib/core/types";
import { addDays, partOfDay, startOfDay, toDateKey } from "../src/lib/core/time";
import { buildLifeState } from "../src/lib/context/gateway";

/* ------------------------------------------------------------------ */
/* Deterministic randomness                                            */
/* ------------------------------------------------------------------ */

/** Mulberry32 — small, fast, and stable across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20240517);
const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)];
const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);

function atHour(day: Date, hour: number, minute = 0): Date {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");
  const dbPath = defaultDbPath();

  if (reset && existsSync(dbPath)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = `${dbPath}${suffix}`;
      if (existsSync(f)) rmSync(f, { force: true });
    }
    console.log("Wiped existing database.");
  }

  const existing = existsSync(dbPath);
  const store = new XanaStore(dbPath);

  if (existing && !reset) {
    const counts = store.counts();
    if (counts.memories > 0 || counts.tasks > 0) {
      console.log(
        `Database already has data (${counts.tasks} tasks, ${counts.memories} memories, ${counts.habits} habits).`,
      );
      console.log("Run `npm run seed -- --reset` to rebuild from scratch.");
      store.close();
      return;
    }
  }

  const today = startOfDay(new Date());
  console.log(`Seeding Xana's world as of ${toDateKey(today)}…\n`);

  seedMemories(store);
  const habits = seedHabits(store, today);
  seedHealth(store, today);
  seedFocus(store, today);
  const goals = seedGoals(store, today);
  seedEvents(store, today);
  seedTasks(store, today);
  seedNotes(store);
  seedConversation(store);

  /* --- Warm the derived layer so the first page load is instant and the
         pattern detectors have already run against the seeded history. --- */
  const state = await buildLifeState({ force: true });

  const counts = store.counts();
  console.log("Seeded:");
  for (const [table, n] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(16)} ${n}`);
  }

  console.log("\nWhat Xana found in it:");
  console.log(`  ${partOfDay()}, headline: ${state.headline}`);
  console.log(`  energy     ${state.energy.score}/100 (${state.energy.band}) — ${state.energy.note}`);
  console.log(`  focus      ${state.tasks.focus.length} triaged, ${state.tasks.overdue.length} overdue`);
  console.log(`  habits     ${state.habits.map((h) => `${h.name} ${h.thisWeek}/${h.targetPerWeek}${h.atRisk ? "!" : ""}`).join(", ")}`);
  console.log(`  goals      ${state.goals.map((g) => `${g.goal.title} ${Math.round(g.progress.progress * 100)}% ${g.progress.pace}`).join(", ")}`);
  if (state.patterns.length > 0) {
    for (const p of state.patterns) {
      console.log(`  pattern    ${p.observation}  (${p.confidence})`);
    }
  } else {
    console.log("  pattern    none cleared the confidence threshold");
  }
  if (state.nudges.length > 0) {
    for (const n of state.nudges) console.log(`  nudge      [${n.tone}] ${n.text}`);
  }

  console.log(`\nMemory holds ${counts.memories} records.`);
  console.log(`Habits tracked: ${habits.length}. Goals: ${goals.length}.`);
  console.log("\nDone. Run `npm run dev` and open http://localhost:4310");
  store.close();
}

/* ------------------------------------------------------------------ */
/* Memory: the people, projects and preferences of a life              */
/* ------------------------------------------------------------------ */

function seedMemories(store: XanaStore): void {
  const memories: Array<Parameters<XanaStore["remember"]>[0]> = [
    {
      kind: "person",
      title: "Mom",
      content: "Mom. Calls on Sundays usually. Prefers a phone call to a text. Mentioned her knee is bothering her again.",
      entities: ["Mom"],
      tags: ["family", "weekly"],
      salience: 0.9,
      source: "conversation",
    },
    {
      kind: "person",
      title: "Sam Okafor",
      content: "Sam Okafor — collaborator on the Aurora project. Reviews drafts fast, prefers Friday afternoons for syncs. Writes in British English.",
      entities: ["Sam Okafor"],
      tags: ["work", "aurora"],
      salience: 0.82,
      source: "conversation",
    },
    {
      kind: "person",
      title: "Priya",
      content: "Priya runs the Tuesday running group. She is training for the same half marathon in spring.",
      entities: ["Priya"],
      tags: ["running", "social"],
      salience: 0.7,
      source: "conversation",
    },
    {
      kind: "project",
      title: "Aurora",
      content: "Aurora — the main work project. A rewrite of the reporting pipeline. Ship target is the end of next quarter. Sam owns the parser, I own the scheduler.",
      entities: ["Aurora", "Sam Okafor"],
      tags: ["work", "priority"],
      salience: 0.95,
      source: "conversation",
    },
    {
      kind: "decision",
      title: "Chose Postgres over SQLite for Aurora",
      content: "Decided to go with Postgres for the Aurora scheduler rather than embedded SQLite, because concurrent writers became a real problem in staging. Sam agreed it was the right call.",
      entities: ["Aurora", "Postgres", "Sam Okafor"],
      tags: ["architecture", "decision"],
      salience: 0.88,
      source: "conversation",
    },
    {
      kind: "decision",
      title: "Dropped the mobile app for now",
      content: "Decided to drop the mobile companion app until after the reporting launch. Not enough time and nobody asked for it twice.",
      entities: ["Aurora"],
      tags: ["scope", "decision"],
      salience: 0.72,
      source: "conversation",
    },
    {
      kind: "preference",
      title: "Prefers mornings for deep work",
      content: "Strongly prefers to do deep work before 11am. Meetings before noon are actively resented. Best thinking happens early, especially after a run.",
      entities: [],
      tags: ["work-style", "energy"],
      salience: 0.9,
      source: "conversation",
    },
    {
      kind: "preference",
      title: "Dislikes back-to-back meetings",
      content: "Hates back-to-back meetings with no gap. Needs at least 15 minutes between calls to reset and take notes.",
      entities: [],
      tags: ["work-style", "calendar"],
      salience: 0.8,
      source: "conversation",
    },
    {
      kind: "preference",
      title: "Coffee only before noon",
      content: "Cut caffeine after midday to protect sleep. It has helped. Tea in the afternoon instead.",
      entities: [],
      tags: ["health", "sleep"],
      salience: 0.65,
      source: "conversation",
    },
    {
      kind: "place",
      title: "The Reading Room",
      content: "The Reading Room on the high street is the reliable spot for focused afternoons. Quiet, good wifi, no music.",
      entities: ["The Reading Room"],
      tags: ["workspace"],
      salience: 0.55,
      source: "conversation",
    },
    {
      kind: "fact",
      title: "Half marathon in the spring",
      content: "Signed up for the spring half marathon. Training plan started, currently comfortable at 8km. Priya is doing the same race.",
      entities: ["Priya"],
      tags: ["running", "goal"],
      salience: 0.78,
      source: "conversation",
    },
    {
      kind: "note",
      title: "Ideas for the launch post",
      content: "Launch post angles: the migration story, the concurrency bug that forced Postgres, and what we got wrong about caching. The migration story is the strongest hook.",
      entities: ["Aurora", "Postgres"],
      tags: ["writing", "launch"],
      salience: 0.6,
      source: "conversation",
    },
  ];

  for (const m of memories) store.remember(m);
}

/* ------------------------------------------------------------------ */
/* Habits                                                              */
/* ------------------------------------------------------------------ */

function seedHabits(store: XanaStore, today: Date): string[] {
  const specs: Array<{ name: string; target: number; history: (daysAgo: number, date: Date) => boolean; hint: string }> = [
    {
      name: "Meditation",
      target: 7,
      // A long, current streak — deliberately missing today so it reads at-risk.
      history: (i) => i < 26,
      hint: "10 minutes, before the day starts",
    },
    {
      name: "Run",
      target: 4,
      history: (i, date) => {
        const dow = date.getDay();
        // Tuesday group run is the anchor; Saturday long run is often skipped.
        if (dow === 2) return true;
        if (dow === 6) return rand() > 0.35;
        if (dow === 4) return rand() > 0.5;
        return false;
      },
      hint: "Tuesday group, Saturday long",
    },
    {
      name: "Read",
      target: 5,
      history: () => rand() > 0.3,
      hint: "20 pages, paper not screen",
    },
    {
      name: "No phone before 9am",
      target: 7,
      history: (i) => rand() > (i < 10 ? 0.15 : 0.35),
      hint: "Hardest one. Worth it.",
    },
  ];

  const ids: string[] = [];
  for (const spec of specs) {
    const habit = store.createHabit({ name: spec.name, targetPerWeek: spec.target, cadenceHint: spec.hint });
    ids.push(habit.id);

    for (let i = 90; i >= 1; i--) {
      const date = addDays(today, -i);
      if (spec.history(i, date)) store.logHabit(habit.id, toDateKey(date));
    }
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* Health — with a real short-sleep -> low-mood correlation            */
/* ------------------------------------------------------------------ */

function seedHealth(store: XanaStore, today: Date): void {
  const dow = (d: Date) => d.getDay();

  for (let i = 62; i >= 0; i--) {
    const date = addDays(today, -i);
    const day = dow(date);
    const weekend = day === 0 || day === 6;

    // Weekends run longer; Wednesday is the reliably short night.
    let sleep = weekend ? between(7.6, 9.0) : between(6.6, 8.2);
    if (day === 3 && rand() > 0.35) sleep = between(5.2, 6.3);
    if (rand() > 0.88) sleep = between(4.6, 6.0);

    const short = sleep < 6.5;
    const mood: MoodLabel = short
      ? rand() > 0.45
        ? "low"
        : "flat"
      : sleep > 7.8
        ? rand() > 0.4
          ? "bright"
          : "good"
        : rand() > 0.3
          ? "good"
          : "flat";

    const steps = Math.round(weekend ? between(4000, 14000) : between(3500, 11000));
    const sample: HealthSample = {
      date: toDateKey(date),
      sleepHours: Number(sleep.toFixed(1)),
      sleepQuality: Number((short ? between(0.35, 0.6) : between(0.65, 0.92)).toFixed(2)),
      steps,
      activeMinutes: Math.round(steps / 110),
      restingHeartRate: Math.round(short ? between(58, 66) : between(50, 58)),
      mood,
      source: "seed",
    };
    store.upsertHealth(sample);
  }
}

/* ------------------------------------------------------------------ */
/* Focus sessions — clustered on Tuesday and Thursday mornings         */
/* ------------------------------------------------------------------ */

function seedFocus(store: XanaStore, today: Date): void {
  const labels = [
    "Aurora scheduler",
    "Aurora parser",
    "writing the launch post",
    "designing data-intensive applications",
    "reviewing Sam's PR",
    "training plan",
  ];

  /*
   * Weighted by weekday so Tuesday genuinely dominates. The deep-work detector
   * requires the best day to hold >=28% of focused minutes and at least double
   * the worst, so an even spread would (correctly) find no pattern at all.
   */
  const weight: Record<number, number> = {
    0: 0.08, // Sun
    1: 0.3,  // Mon — admin, light
    2: 1.0,  // Tue — the anchor
    3: 0.45, // Wed
    4: 0.75, // Thu — the second deep day
    5: 0.2,  // Fri — meetings eat it
    6: 0.08, // Sat
  };

  for (let i = 56; i >= 0; i--) {
    const date = addDays(today, -i);
    const chance = weight[date.getDay()] ?? 0.2;
    if (rand() > chance) continue;

    const isDeepDay = date.getDay() === 2;
    const sessions = isDeepDay && rand() > 0.25 ? 2 : 1;

    for (let s = 0; s < sessions; s++) {
      const startHour = s === 0 ? 9 : 14;
      const minutes = Math.round(between(isDeepDay ? 70 : 25, isDeepDay ? 120 : 60));
      const session = store.startFocus(pick(labels), minutes, undefined);
      // Backdate the session so the weekly rollups are meaningful.
      store.db
        .prepare(`UPDATE focus_sessions SET started_at = ?, completed = ? WHERE id = ?`)
        .run(atHour(date, startHour).toISOString(), rand() > 0.12 ? 1 : 0, session.id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Goals                                                               */
/* ------------------------------------------------------------------ */

function seedGoals(store: XanaStore, today: Date): string[] {
  const ids: string[] = [];

  // On track: steady, recent milestone completions.
  const marathon = store.createGoal({
    title: "Run the spring half marathon",
    why: "Prove to myself that consistency beats intensity.",
    horizon: "mid",
    targetDate: toDateKey(addDays(today, 120)),
    area: "Health",
    cadence: "4 runs a week",
    milestones: [
      { title: "Run 5km without stopping", done: true, completedAt: addDays(today, -70).toISOString(), due: toDateKey(addDays(today, -70)) },
      { title: "Run 10km", done: true, completedAt: addDays(today, -38).toISOString(), due: toDateKey(addDays(today, -40)) },
      { title: "Run 15km", done: true, completedAt: addDays(today, -9).toISOString(), due: toDateKey(addDays(today, -5)) },
      { title: "Run 18km", done: false, due: toDateKey(addDays(today, 18)) },
      { title: "Race day", done: false, due: toDateKey(addDays(today, 120)) },
    ],
  });
  ids.push(marathon.id);

  // Stalled: nothing has moved in weeks.
  const book = store.createGoal({
    title: "Finish the book proposal",
    why: "The idea has been in a drawer for two years.",
    horizon: "short",
    targetDate: toDateKey(addDays(today, 35)),
    area: "Writing",
    cadence: "Two sessions a week",
    milestones: [
      { title: "Outline the ten chapters", done: true, completedAt: addDays(today, -64).toISOString() },
      { title: "Write the sample chapter", done: true, completedAt: addDays(today, -48).toISOString() },
      { title: "Draft the proposal letter", done: false, due: toDateKey(addDays(today, 12)) },
      { title: "Send to three publishers", done: false, due: toDateKey(addDays(today, 35)) },
    ],
  });
  ids.push(book.id);

  // Long horizon, early days.
  const rust = store.createGoal({
    title: "Get genuinely good at Rust",
    why: "The scheduler work keeps landing back in systems code.",
    horizon: "long",
    targetDate: toDateKey(addDays(today, 300)),
    area: "Craft",
    cadence: "One exercise a day",
    milestones: [
      { title: "Finish the book", done: true, completedAt: addDays(today, -20).toISOString() },
      { title: "Rewrite the scheduler in Rust", done: false, due: toDateKey(addDays(today, 90)) },
      { title: "Contribute to an open-source crate", done: false, due: toDateKey(addDays(today, 200)) },
    ],
  });
  ids.push(rust.id);

  return ids;
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function seedEvents(store: XanaStore, today: Date): void {
  const add = (
    title: string,
    dayOffset: number,
    startHour: number,
    minutes: number,
    extra: { location?: string; attendees?: string[]; source?: string; xanaAuthored?: boolean } = {},
  ) => {
    const date = addDays(today, dayOffset);
    store.createEvent({
      title,
      start: atHour(date, startHour).toISOString(),
      end: atHour(date, startHour, minutes).toISOString(),
      location: extra.location,
      attendees: extra.attendees ?? [],
      source: extra.source ?? "seed",
      xanaAuthored: extra.xanaAuthored ?? false,
    });
  };

  // Recurring anchors.
  for (let w = -3; w <= 3; w++) {
    add("Tuesday run group", w * 7 + 2, 7, 45, { location: "Riverside path", attendees: ["Priya"] });
    add("Aurora weekly sync", w * 7 + 1, 11, 45, { attendees: ["Sam Okafor"] });
  }

  // Today: a deliberately crowded day, so crowding detection has something.
  add("Stand-up", 0, 9, 15);
  add("Design review — scheduler", 0, 10, 60, { attendees: ["Sam Okafor"] });
  add("1:1 with Sam", 0, 13, 30, { attendees: ["Sam Okafor"] });
  add("Vendor call", 0, 15, 45, { location: "Zoom" });
  add("Retro", 0, 16, 45);

  // Tomorrow.
  add("Dentist", 1, 8, 45, { location: "High Street" });
  add("Aurora planning", 1, 14, 90, { attendees: ["Sam Okafor"] });

  // Rest of the week.
  add("Dinner at Mom's", 3, 19, 120, { location: "Mom's", attendees: ["Mom"] });
  add("Book proposal review", 4, 10, 60);
  add("Long run", 5, 8, 90, { location: "Canal loop" });
  add("Call with Priya", 6, 17, 30, { attendees: ["Priya"] });

  // Something Xana previously protected, to show write-back in the history.
  add("Protected: deep work — Aurora scheduler", 2, 9, 120, { xanaAuthored: true, source: "xana" });
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

function seedTasks(store: XanaStore, today: Date): void {
  const specs: Array<Parameters<XanaStore["createTask"]>[0] & { createdOffset?: number }> = [
    { title: "Review Sam's parser PR", priority: 1, project: "Aurora", due: atHour(today, 17).toISOString(), estimateMinutes: 45, energy: "high", people: ["Sam Okafor"], createdOffset: -2 },
    { title: "Draft the launch post outline", priority: 2, project: "Aurora", due: toDateKey(addDays(today, 2)), estimateMinutes: 60, energy: "high", createdOffset: -5 },
    { title: "Book the dentist follow-up", priority: 3, due: toDateKey(addDays(today, -3)), estimateMinutes: 5, energy: "low", createdOffset: -9 },
    { title: "Send Mom the photos from Sunday", priority: 3, people: ["Mom"], due: toDateKey(addDays(today, -1)), estimateMinutes: 10, energy: "low", createdOffset: -4 },
    { title: "Write the proposal letter", priority: 2, project: "Book", estimateMinutes: 90, energy: "high", createdOffset: -21 },
    { title: "Renew the domain", priority: 2, due: toDateKey(addDays(today, 4)), estimateMinutes: 10, energy: "low", createdOffset: -12 },
    { title: "Order new running shoes", priority: 3, project: "Health", estimateMinutes: 15, energy: "low", createdOffset: -8 },
    { title: "Read the Postgres partitioning docs", priority: 3, project: "Aurora", estimateMinutes: 40, energy: "medium", createdOffset: -6 },
    { title: "Reply to the accountant", priority: 2, due: toDateKey(addDays(today, -2)), estimateMinutes: 20, energy: "low", createdOffset: -7 },
    { title: "Plan the 18km route", priority: 3, project: "Health", due: toDateKey(addDays(today, 3)), estimateMinutes: 20, energy: "low", createdOffset: -3 },
    { title: "Clear the inbox to zero", priority: 4, estimateMinutes: 30, energy: "low", createdOffset: -1 },
    { title: "Update the training plan spreadsheet", priority: 4, project: "Health", estimateMinutes: 15, createdOffset: -5 },
  ];

  const created: string[] = [];
  for (const spec of specs) {
    const { createdOffset, ...rest } = spec;
    const task = store.createTask({
      ...rest,
      source: "seed",
      createdAt: createdOffset !== undefined ? addDays(today, createdOffset).toISOString() : undefined,
    });
    created.push(task.id);
  }

  /* --- Completed history, so patterns and reflections have material. --- */
  const doneTitles = [
    "Fix the flaky integration test",
    "Write up the caching decision",
    "Cancel the unused subscription",
    "Migrate the staging database",
    "Review Priya's training plan",
    "Draft the migration story",
    "Refactor the retry logic",
    "Book the flights",
    "Update the onboarding doc",
    "Clear the old branches",
    "Pair with Sam on the parser",
    "Write the incident note",
    "Plan the sprint",
    "Tidy the monitoring dashboard",
    "Answer the vendor questionnaire",
    "Draft the release notes",
    "Review the schema change",
    "Set up the alerting rules",
    "Read the concurrency chapter",
    "Ship the reporting fix",
  ];

  let i = 0;
  for (const title of doneTitles) {
    const dayOffset = -Math.floor(between(1, 55));
    const date = addDays(today, dayOffset);
    // Completions cluster in the morning, matching the stated preference.
    const hour = rand() > 0.3 ? Math.floor(between(8, 12)) : Math.floor(between(14, 18));
    store.createTask({
      title,
      priority: rand() > 0.6 ? 2 : 3,
      project: rand() > 0.5 ? "Aurora" : undefined,
      source: "seed",
      status: "done",
      createdAt: addDays(date, -Math.floor(between(1, 6))).toISOString(),
      completedAt: atHour(date, hour, Math.floor(between(0, 59))).toISOString(),
    });
    i++;
  }
  void i;

  // One task in flight, so "doing" is represented.
  if (created[1]) store.updateTaskStatus(created[1], "doing");
}

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/* ------------------------------------------------------------------ */

function seedNotes(store: XanaStore): void {
  const notes: Array<{ title: string; body: string; tags: string[] }> = [
    {
      title: "Aurora — architecture decisions",
      body: `Scheduler owns all timing. Parser is pure and stateless, which is why Sam can work on it independently.

We went with Postgres over SQLite after the staging incident: three concurrent writers and the whole thing locked up. Embedded storage was the wrong call for a service with more than one process.

Caching: we got this wrong twice. First we cached too aggressively at the query layer, then not at all. The answer is caching at the boundary, with explicit invalidation on write.`,
      tags: ["aurora", "architecture"],
    },
    {
      title: "Weekly review — how the weeks actually go",
      body: `The pattern is obvious when written down. Tuesday and Thursday mornings are when real work happens. Monday is administration and recovery. Friday afternoon is gone to meetings.

Protecting Tuesday morning is worth more than any productivity system.`,
      tags: ["review", "work-style"],
    },
    {
      title: "Half marathon training notes",
      body: `Currently comfortable at 8km. The Tuesday group run is the anchor — missing it makes the whole week fall apart.

Long runs on Saturday. Sleep is the limiter, not legs. Every time sleep drops below six hours, the next run feels twice as hard.`,
      tags: ["health", "running"],
    },
    {
      title: "Ideas for the launch post",
      body: `Three angles, in order of strength:

1. The migration story — moving off embedded storage under load, what broke, what we would do differently.
2. The concurrency bug that forced the decision. Good technical detail but narrow.
3. What we got wrong about caching. Honest, but maybe too inside-baseball.

Lead with the migration. It has a real narrative and a real lesson.`,
      tags: ["writing", "launch"],
    },
    {
      title: "Things to tell Sam",
      body: `Mention the retry backoff change. Ask whether the parser should tolerate malformed rows or fail loudly — I lean towards failing loudly, but he owns that code.

Also: he prefers Friday afternoons for anything that needs real discussion.`,
      tags: ["aurora", "people"],
    },
  ];

  for (const n of notes) store.createNote({ ...n, source: "seed" });
}

/* ------------------------------------------------------------------ */
/* Conversation history                                                */
/* ------------------------------------------------------------------ */

function seedConversation(store: XanaStore): void {
  const turns: Array<[string, string]> = [
    ["remind me to call Mom Friday", "Noted — \"call Mom\" for Friday."],
    ["what did I decide about the database", "Postgres, over SQLite. The staging incident forced it — three concurrent writers locked the embedded store."],
    ["start a 90 minute focus session on the scheduler", "90 minutes on \"scheduler\". Instrumental post-rock or a steady 90bpm pulse."],
    ["log meditation", "Meditation — logged. That one has been running a while."],
    ["how are my goals doing", "One is moving well, one has stalled. The book proposal hasn't shifted in weeks."],
  ];

  for (const [user, xana] of turns.reverse()) {
    store.logMessage("user", user, "seed");
    store.logMessage("xana", xana, "seed", { engine: "local" });
  }
}

main().catch((err: unknown) => {
  console.error("\nSeed failed:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
});
