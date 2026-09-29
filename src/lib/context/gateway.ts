/**
 * The context gateway: one call that assembles Xana's entire view of now.
 *
 * This is the `/xana/context` endpoint's engine. Everything Xana says or does
 * starts here — adapters provide raw life data, the derived layer turns it into
 * judgement (energy, patterns, pace, nudges), memory provides recall, and the
 * result is a single `LifeState`.
 *
 * Read order matters and is deliberate:
 *
 *   1. adapters       -> what is true right now
 *   2. habits + goals -> derived judgement on it
 *   3. energy         -> needs calendar and health, feeds the media suggestion
 *   4. recall         -> needs a query, which is built from the state itself
 *   5. patterns       -> needs every input above
 *   6. nudges         -> needs patterns, and outranks everything for attention
 *   7. headline       -> the single line that summarises the result
 *
 * A short TTL cache absorbs the UI's polling without letting the data go stale
 * enough to matter.
 */

import type {
  AdapterStatus,
  CalendarEvent,
  EnergyForecast,
  LifeState,
  MemoryHit,
  Task,
} from "../core/types";
import { AdapterRegistry } from "../adapters/registry";
import { getStore } from "../core/store";
import {
  addDays,
  clamp,
  daysBetween,
  endOfDay,
  nowIso,
  partOfDay,
  startOfDay,
  startOfWeek,
  toDateKey,
} from "../core/time";
import { energyForecast } from "../derived/energy";
import { computeGoalProgress } from "../derived/goals";
import { habitsWithHealth, latestHealth, moodTrend, sleepDebt } from "../derived/habits";
import { detectPatterns } from "../derived/patterns";
import { buildNudges, headlineFor } from "../derived/nudges";
import { ingestSnapshot, knownPeople } from "../derived/memory";

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 4_000;

let cached: { at: number; state: LifeState } | undefined;
let lastEnergy: EnergyForecast | undefined;
let lastStatuses: AdapterStatus[] = [];
let registry: AdapterRegistry | undefined;

function getRegistryInstance(): AdapterRegistry {
  if (!registry) {
    registry = new AdapterRegistry({
      // The media adapter wants today's band, which is only known after the
      // first assembly. Last-known is the right answer here.
      band: () => lastEnergy?.band ?? "steady",
      knownPeople: () => knownPeople(),
    });
  }
  return registry;
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export interface ContextOptions {
  /** Bypass the TTL cache and re-read every adapter. */
  force?: boolean;
  /** Skip writing snapshot data into memory (used by read-only paths). */
  skipIngest?: boolean;
  now?: Date;
}

export async function buildLifeState(opts: ContextOptions = {}): Promise<LifeState> {
  const now = opts.now ?? new Date();
  if (!opts.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.state;
  }

  const store = getStore();
  const reg = getRegistryInstance();
  const snapshot = await reg.collect();
  const sources = snapshot.statuses;
  lastStatuses = sources;

  /* --- Calendar: today, next, and free time. --- */
  const todayKey = toDateKey(now);
  const events = dedupeEvents(snapshot.events).sort((a, b) => a.start.localeCompare(b.start));
  const todaysEvents = events.filter((e) => toDateKey(new Date(e.start)) === todayKey);
  const next = events.find((e) => new Date(e.start) > now);

  /* --- Tasks: triage them, because a list is not a decision. --- */
  const openTasks = snapshot.tasks.filter((t) => t.status === "open" || t.status === "doing");
  const overdue = openTasks
    .filter((t) => t.due && new Date(t.due) < startOfDay(now))
    .sort((a, b) => a.due!.localeCompare(b.due!));
  const focus = triage(openTasks, todaysEvents, now);

  const weekStart = startOfWeek(now).toISOString();
  const completedThisWeek = store.tasksCompletedSince(weekStart).length;

  /* --- Habits and goals. --- */
  const habits = habitsWithHealth(store.listHabits(), now);
  const goals = store.listGoals(["active"]).map((goal) => ({ goal, progress: computeGoalProgress(goal, now) }));

  /* --- Health. --- */
  const healthSamples = [...snapshot.health].sort((a, b) => a.date.localeCompare(b.date));
  const recent = healthSamples.filter((h) => h.date >= toDateKey(addDays(now, -6)));
  const sleepValues = recent.map((h) => h.sleepHours).filter((v): v is number => typeof v === "number");
  const sleepAvgHours =
    sleepValues.length > 0 ? sleepValues.reduce((a, b) => a + b, 0) / sleepValues.length : undefined;

  /* --- Focus sessions. --- */
  const focusSessions = store.focusBetween(weekStart, endOfDay(now).toISOString());
  const focusTotal = focusSessions.reduce((acc, f) => acc + f.minutes, 0);

  /* --- Energy: needs calendar, health, tasks and focus. --- */
  const energy = energyForecast({
    health: healthSamples,
    events: todaysEvents,
    tasks: focus,
    focus: focusSessions,
    now,
  });
  lastEnergy = energy;

  /* --- Free time in the waking day. --- */
  const freeMinutes = computeFreeMinutes(todaysEvents, now);

  /* --- Recall: ask the store what matters about right now. --- */
  const recallQuery = buildRecallQuery({ next, focus, patterns: [] });
  let memory: MemoryHit[] = store.recall(recallQuery, { limit: 5, minScore: 0.1 });
  if (memory.length === 0) {
    // Nothing matched the moment; surface what has mattered most lately.
    memory = store
      .allMemories()
      .sort((a, b) => b.salience - a.salience || b.createdAt.localeCompare(a.createdAt))
      .slice(0, 3)
      .map((m) => ({ memory: m, score: m.salience, reason: "recent and significant" }));
  }

  /* --- Patterns, then nudges, then the headline. --- */
  const patterns = detectPatterns({
    focus: focusSessions,
    habits,
    goals,
    health: healthSamples,
    tasks: snapshot.tasks,
    events,
    now,
  });

  const nudges = buildNudges({
    tasks: openTasks,
    events: todayKey ? todaysEvents : events,
    habits,
    goals,
    health: healthSamples,
    weather: snapshot.weather,
    mail: snapshot.mail,
    patterns,
    freeMinutes,
    now,
  });

  const pod = partOfDay(now);
  const headline = headlineFor({ partOfDay: pod, events: todaysEvents, tasks: focus, nudges, now });

  const state: LifeState = {
    generatedAt: nowIso(),
    partOfDay: pod,
    headline,
    calendar: {
      today: todaysEvents,
      next,
      freeMinutes,
    },
    tasks: {
      focus,
      overdue,
      openCount: openTasks.length,
      completedThisWeek,
    },
    habits,
    goals,
    health: {
      latest: latestHealth(healthSamples),
      sleepAvgHours,
      moodTrend: moodTrend(healthSamples).filter((m): m is NonNullable<typeof m> => Boolean(m)),
      sleepDebtHours: sleepDebt(healthSamples),
    },
    weather: snapshot.weather,
    media: snapshot.media,
    finance: snapshot.finance,
    mail: snapshot.mail,
    patterns,
    energy,
    nudges,
    sources,
    memory,
    focus: {
      sessionsThisWeek: focusSessions,
      totalMinutes: focusTotal,
      lastSession: focusSessions[0],
    },
  };

  /* --- Write path: distil the snapshot into durable memory. --- */
  if (!opts.skipIngest) {
    try {
      ingestSnapshot(snapshot, store);
    } catch {
      // Ingestion is best-effort; a memory write must never fail the life state.
    }
  }

  cached = { at: Date.now(), state };
  return state;
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

/** Last-known adapter statuses without touching the network. */
export function adapterStatuses(): AdapterStatus[] {
  const reg = getRegistryInstance();
  const live = reg.statuses();
  // Prefer whatever the last full assembly recorded, so detail strings are rich.
  if (lastStatuses.length > 0) {
    const byId = new Map(lastStatuses.map((s) => [s.id, s]));
    return live.map((s) => byId.get(s.id) ?? s);
  }
  return live;
}

/** A cheap state summary for the presence loop. */
export function summarise(state: LifeState): {
  headline: string;
  attention: number;
  energyScore: number;
} {
  return {
    headline: state.headline,
    attention: state.nudges.filter((n) => n.tone === "warn" || n.tone === "suggest").length,
    energyScore: state.energy.score,
  };
}

/**
 * Triage: rank open tasks by what deserves attention today. Due date dominates,
 * then priority, then whether it fits the day's available energy.
 */
export function triage(tasks: Task[], events: CalendarEvent[], now: Date): Task[] {
  const meetingMinutes = events.reduce(
    (acc, e) => acc + Math.max(0, (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60_000),
    0,
  );
  const overloaded = meetingMinutes > 180;

  const scored = tasks.map((task) => {
    let score = 0;
    const priorityWeight = { 1: 40, 2: 26, 3: 14, 4: 6 }[task.priority];
    score += priorityWeight;

    if (task.due) {
      const days = daysBetween(now, new Date(task.due));
      if (days < 0) score += 60 + Math.min(30, Math.abs(days) * 4);
      else if (days === 0) score += 48;
      else if (days === 1) score += 30;
      else if (days <= 3) score += 18;
      else if (days <= 7) score += 8;
    }

    // On a heavy day, cheap wins are worth more than ambitious ones.
    if (overloaded && task.energy === "low") score += 10;
    if (task.status === "doing") score += 14;
    if ((task.people ?? []).length > 0) score += 5;

    // Gently favour things that have been waiting.
    const age = daysBetween(new Date(task.createdAt), now);
    score += Math.min(10, age * 0.6);

    return { task, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((s) => s.task);
}

/** Free minutes left between now and the end of the waking day. */
export function computeFreeMinutes(events: CalendarEvent[], now: Date): number {
  const dayStart = new Date(now);
  const dayEnd = new Date(now);
  dayEnd.setHours(21, 0, 0, 0);
  if (dayEnd <= dayStart) return 0;

  const busy = events
    .filter((e) => !e.allDay)
    .map((e) => ({
      start: Math.max(new Date(e.start).getTime(), dayStart.getTime()),
      end: Math.min(new Date(e.end).getTime(), dayEnd.getTime()),
    }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  let free = 0;
  let cursor = dayStart.getTime();
  for (const b of busy) {
    if (b.start > cursor) free += b.start - cursor;
    cursor = Math.max(cursor, b.end);
  }
  if (dayEnd.getTime() > cursor) free += dayEnd.getTime() - cursor;

  return Math.round(clamp(free / 60_000, 0, 24 * 60));
}

/** Build the semantic query that decides what Xana recalls unprompted. */
export function buildRecallQuery(input: {
  next?: CalendarEvent;
  focus: Task[];
  patterns: Array<{ observation: string }>;
}): string {
  const parts: string[] = [];
  if (input.next) parts.push(input.next.title, ...(input.next.attendees ?? []));
  for (const t of input.focus.slice(0, 3)) {
    parts.push(t.title, ...(t.people ?? []), ...(t.project ? [t.project] : []));
  }
  for (const p of input.patterns.slice(0, 2)) parts.push(p.observation);
  return parts.join(" ").trim() || "today priorities";
}

/** Same commitment seen twice (local copy plus feed) should appear once. */
export function dedupeEvents(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Map<string, CalendarEvent>();
  for (const e of events) {
    const key = `${e.title.trim().toLowerCase()}@${new Date(e.start).setSeconds(0, 0)}`;
    const prev = seen.get(key);
    // Prefer the richer record: one with a location, or a remote source.
    if (!prev) {
      seen.set(key, e);
      continue;
    }
    const prevScore = (prev.location ? 1 : 0) + (prev.source !== "local" ? 1 : 0);
    const nextScore = (e.location ? 1 : 0) + (e.source !== "local" ? 1 : 0);
    if (nextScore > prevScore) seen.set(key, e);
  }
  return [...seen.values()];
}

/**
 * Invalidate everything downstream of a write: the assembled state and every
 * adapter's cached slice. Called after any action.
 *
 * Both layers must be dropped. Clearing only the gateway cache would rebuild
 * the state from adapter caches that still predate the write, so the UI would
 * show the old world for up to a full TTL.
 */
export function invalidateContext(): void {
  cached = undefined;
  registry?.invalidate();
}

export { lastEnergy };
