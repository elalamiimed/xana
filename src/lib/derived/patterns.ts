/**
 * Behavioural pattern detection.
 *
 * Xana's most useful property is noticing something you have not: that your
 * deep work clusters on Tuesdays, that short sleep precedes your flat days,
 * that a streak is one missed day from breaking. Each detector returns a
 * `Pattern` with the concrete numbers behind it, because an observation without
 * evidence is astrology.
 *
 * Every detector must clear a minimum sample before it may speak. Silence is
 * better than a confident guess from three data points.
 */

import type {
  CalendarEvent,
  FocusSession,
  Goal,
  GoalProgress,
  HabitWithHealth,
  HealthSample,
  Pattern,
  Task,
} from "../core/types";
import { nowIso, partOfDay, round, toDateKey, uid, daysBetween, startOfWeek } from "../core/time";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface PatternInputs {
  focus: FocusSession[];
  habits: HabitWithHealth[];
  goals: Array<{ goal: Goal; progress: GoalProgress }>;
  health: HealthSample[];
  tasks: Task[];
  events: CalendarEvent[];
  now?: Date;
}

/** Deep work clusters on particular weekdays. */
function deepWorkDay(input: PatternInputs): Pattern | undefined {
  const completed = input.focus.filter((f) => f.completed);
  if (completed.length < 6) return undefined;

  const byDay = new Map<number, { minutes: number; sessions: number }>();
  for (const f of completed) {
    const dow = new Date(f.startedAt).getDay();
    const cur = byDay.get(dow) ?? { minutes: 0, sessions: 0 };
    cur.minutes += f.minutes;
    cur.sessions += 1;
    byDay.set(dow, cur);
  }
  if (byDay.size < 3) return undefined;

  const ranked = [...byDay.entries()].sort((a, b) => b[1].minutes - a[1].minutes);
  const [bestDow, best] = ranked[0];
  const worstMinutes = ranked[ranked.length - 1][1].minutes;
  if (best.minutes < 90) return undefined;

  // Only claim a pattern when the winner is clearly separated from the field.
  const totalMinutes = ranked.reduce((acc, [, v]) => acc + v.minutes, 0);
  const share = best.minutes / totalMinutes;
  if (share < 0.28 || best.minutes < worstMinutes * 2) return undefined;

  const day = DAY_NAMES[bestDow];
  return {
    id: uid("pat"),
    key: `deep-work-${DAY_NAMES[bestDow].toLowerCase()}`,
    observation: `You're most consistent with deep work on ${day}s — ${Math.round(best.minutes / 60)}h across ${best.sessions} sessions, ${Math.round(share * 100)}% of your focused time.`,
    confidence: round(Math.min(0.9, 0.4 + share), 2),
    evidence: [
      `${best.minutes}m focused on ${day}s`,
      `${completed.length} completed sessions on record`,
      `next best day: ${Math.round(ranked[1][1].minutes)}m`,
    ],
    suggestion: `Want me to protect ${day} mornings?`,
    detectedAt: nowIso(),
  };
}

/** A habit one or two misses from losing its streak. */
function habitAtRisk(input: PatternInputs): Pattern | undefined {
  const atRisk = input.habits
    .filter((h) => h.streak >= 4 && !h.onPace && h.atRisk)
    .sort((a, b) => b.streak - a.streak)[0];
  if (!atRisk) return undefined;

  const remaining = atRisk.targetPerWeek - atRisk.thisWeek;
  return {
    id: uid("pat"),
    key: `habit-at-risk-${atRisk.id}`,
    observation: `Your ${atRisk.name.toLowerCase()} streak is ${atRisk.streak} days and needs ${remaining} more this week to hold.`,
    confidence: 0.85,
    evidence: [
      `${atRisk.thisWeek} of ${atRisk.targetPerWeek} this week`,
      `${atRisk.streak}-day streak, longest ${atRisk.longestStreak}`,
    ],
    suggestion: `Log it today?`,
    detectedAt: nowIso(),
  };
}

/**
 * Short sleep on one night precedes a flat mood the next day.
 *
 * The pairing is deliberately lagged: mood on day N is matched against sleep on
 * day N-1. Correlating same-day sleep with same-day mood would mostly measure
 * the reverse direction (a bad day makes you log less sleep), which is a
 * different and less actionable claim.
 */
function sleepMoodCoupling(input: PatternInputs): Pattern | undefined {
  const byDay = new Map(input.health.map((h) => [h.date, h]));
  const ordered = [...input.health].sort((a, b) => a.date.localeCompare(b.date));

  const moodScore: Record<string, number> = { low: 0, flat: 1, good: 2, bright: 3 };
  const pairs: Array<{ sleep: number; mood: number }> = [];

  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const today = ordered[i];
    if (typeof prev.sleepHours !== "number" || !today.mood) continue;
    // Only pair consecutive nights, so a gap cannot invent a relationship.
    if (daysBetween(new Date(prev.date), new Date(today.date)) !== 1) continue;
    if (!byDay.has(prev.date)) continue;
    pairs.push({ sleep: prev.sleepHours, mood: moodScore[today.mood] ?? 1 });
  }

  if (pairs.length < 8) return undefined;

  const short = pairs.filter((p) => p.sleep < 6.5);
  const long = pairs.filter((p) => p.sleep >= 7);
  if (short.length < 3 || long.length < 3) return undefined;

  const avg = (list: typeof pairs) => list.reduce((acc, p) => acc + p.mood, 0) / list.length;
  const shortMood = avg(short);
  const longMood = avg(long);
  const gap = longMood - shortMood;
  if (gap < 0.5) return undefined;

  return {
    id: uid("pat"),
    key: "sleep-mood-coupling",
    observation: `Nights under 6.5h cost you roughly ${gap.toFixed(1)} points of mood the next day.`,
    confidence: round(Math.min(0.85, 0.45 + gap * 0.2), 2),
    evidence: [
      `${short.length} short nights, next-day mood averaging ${shortMood.toFixed(1)}/3`,
      `${long.length} full nights, next-day mood averaging ${longMood.toFixed(1)}/3`,
      `${pairs.length} consecutive night/day pairs`,
    ],
    suggestion: `Want a wind-down reminder at 22:30?`,
    detectedAt: nowIso(),
  };
}

/** A goal that has stopped moving. */
function stalledGoal(input: PatternInputs): Pattern | undefined {
  const stalled = input.goals
    .filter((g) => g.progress.pace === "stalled")
    .sort((a, b) => (b.progress.daysRemaining ?? 999) - (a.progress.daysRemaining ?? 999))[0];
  if (!stalled) return undefined;

  return {
    id: uid("pat"),
    key: `goal-stalled-${stalled.goal.id}`,
    observation: `"${stalled.goal.title}" has stalled at ${Math.round(stalled.progress.progress * 100)}%.`,
    confidence: 0.8,
    evidence: [
      stalled.progress.note,
      `${stalled.progress.milestonesDone} of ${stalled.progress.milestonesTotal} milestones done`,
    ],
    suggestion: `Shall I put the next milestone on tomorrow's list?`,
    detectedAt: nowIso(),
  };
}

/** Meetings have eaten the day's usable hours. */
function calendarCrowding(input: PatternInputs): Pattern | undefined {
  const now = input.now ?? new Date();
  const today = input.events.filter((e) => !e.allDay && toDateKey(new Date(e.start)) === toDateKey(now));
  if (today.length < 4) return undefined;

  const bookedMinutes = today.reduce(
    (acc, e) => acc + Math.max(0, (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60_000),
    0,
  );
  if (bookedMinutes < 210) return undefined;

  const longestGap = longestGapMinutes(today, now);

  return {
    id: uid("pat"),
    key: "calendar-crowding",
    observation: `${today.length} blocks today, ${Math.round(bookedMinutes / 60)}h booked${longestGap < 45 ? " — no gap longer than 45m" : ""}.`,
    confidence: 0.9,
    evidence: [
      `${Math.round(bookedMinutes)}m scheduled`,
      longestGap > 0 ? `longest free gap: ${longestGap}m` : "no free gaps",
    ],
    suggestion: longestGap >= 45 ? `Protect the ${longestGap}m gap for one real task?` : `Decline something?`,
    detectedAt: nowIso(),
  };
}

function longestGapMinutes(events: CalendarEvent[], now: Date): number {
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));
  const dayEnd = new Date(now);
  dayEnd.setHours(19, 0, 0, 0);
  let cursor = new Date(Math.max(now.getTime(), new Date(sorted[0].start).getTime()));
  let longest = 0;
  for (const e of sorted) {
    const start = new Date(e.start);
    const end = new Date(e.end);
    if (start > cursor) longest = Math.max(longest, (start.getTime() - cursor.getTime()) / 60_000);
    if (end > cursor) cursor = end;
  }
  if (dayEnd > cursor) longest = Math.max(longest, (dayEnd.getTime() - cursor.getTime()) / 60_000);
  return Math.round(longest);
}

/** A time of day where completions cluster. */
function productiveWindow(input: PatternInputs): Pattern | undefined {
  const completedTasks = input.tasks.filter((t) => t.status === "done" && t.completedAt);
  if (completedTasks.length < 8) return undefined;

  const buckets = new Map<string, number>();
  for (const t of completedTasks) {
    const part = partOfDay(new Date(t.completedAt!));
    buckets.set(part, (buckets.get(part) ?? 0) + 1);
  }
  const ranked = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  const [part, count] = ranked[0];
  const share = count / completedTasks.length;
  if (share < 0.45 || count < 5) return undefined;

  return {
    id: uid("pat"),
    key: `productive-${part}`,
    observation: `${Math.round(share * 100)}% of what you finish, you finish in the ${part}.`,
    confidence: round(Math.min(0.88, 0.45 + share * 0.35), 2),
    evidence: [
      `${count} of ${completedTasks.length} completed tasks in the ${part}`,
      `next busiest: ${ranked[1] ? `${ranked[1][0]} (${ranked[1][1]})` : "n/a"}`,
    ],
    suggestion: `Want me to keep your ${part}s clear of meetings?`,
    detectedAt: nowIso(),
  };
}

/** Focus volume is trending up or down against the previous week. */
function focusTrend(input: PatternInputs): Pattern | undefined {
  const now = input.now ?? new Date();
  const thisWeekStart = startOfWeek(now);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  const inRange = (from: Date, to: Date) =>
    input.focus
      .filter((f) => f.completed)
      .filter((f) => {
        const t = new Date(f.startedAt).getTime();
        return t >= from.getTime() && t < to.getTime();
      })
      .reduce((acc, f) => acc + f.minutes, 0);

  const thisWeek = inRange(thisWeekStart, new Date(thisWeekStart.getTime() + 7 * 86_400_000));
  const lastWeek = inRange(lastWeekStart, thisWeekStart);
  if (lastWeek < 60) return undefined;

  const delta = (thisWeek - lastWeek) / lastWeek;
  if (Math.abs(delta) < 0.3) return undefined;

  const direction = delta > 0 ? "up" : "down";
  return {
    id: uid("pat"),
    key: `focus-trend-${direction}`,
    observation: `Focused time is ${direction} ${Math.round(Math.abs(delta) * 100)}% on last week.`,
    confidence: round(Math.min(0.8, 0.45 + Math.abs(delta) * 0.25), 2),
    evidence: [`${Math.round(thisWeek / 60)}h this week`, `${Math.round(lastWeek / 60)}h last week`],
    suggestion: delta < 0 ? `Want a focus block tomorrow morning?` : undefined,
    detectedAt: nowIso(),
  };
}

/** Newly crossed streak thresholds — worth noticing, once. */
function streakMilestone(input: PatternInputs): Pattern | undefined {
  const hit = input.habits.find((h) => h.streak >= 7 && h.streak % 7 === 0);
  if (!hit) return undefined;
  return {
    id: uid("pat"),
    key: `streak-${hit.id}-${hit.streak}`,
    observation: `${hit.streak} days on ${hit.name.toLowerCase()}. That's the longest run you have.`,
    confidence: 1,
    evidence: [`current ${hit.streak}`, `longest ${hit.longestStreak}`, `${hit.thisWeek}/${hit.targetPerWeek} this week`],
    detectedAt: nowIso(),
  };
}

const DETECTORS = [deepWorkDay, habitAtRisk, sleepMoodCoupling, stalledGoal, calendarCrowding, productiveWindow, focusTrend, streakMilestone];

/**
 * Which family a pattern belongs to, derived from its key. Used to keep the
 * surfaced set diverse — four insights about four different things is more
 * useful than three about habits.
 */
export function patternFamily(key: string): string {
  if (key.startsWith("deep-work") || key.startsWith("focus-trend")) return "focus";
  if (key.startsWith("habit") || key.startsWith("streak")) return "habit";
  if (key.startsWith("sleep-mood")) return "sleep";
  if (key.startsWith("goal-stalled")) return "goal";
  if (key.startsWith("calendar")) return "calendar";
  if (key.startsWith("productive")) return "rhythm";
  return "other";
}

const MAX_PER_FAMILY = 1;
const MAX_PATTERNS = 4;

export function detectPatterns(input: PatternInputs): Pattern[] {
  const out: Pattern[] = [];
  for (const detect of DETECTORS) {
    try {
      const p = detect(input);
      if (p) out.push(p);
    } catch {
      // A detector must never take the life state down with it.
    }
  }

  // Strongest claims first, then thin each family to one so the set stays
  // varied rather than repeating the same observation three ways.
  const ranked = out.sort((a, b) => b.confidence - a.confidence);
  const perFamily = new Map<string, number>();
  const selected: Pattern[] = [];
  for (const p of ranked) {
    const family = patternFamily(p.key);
    const used = perFamily.get(family) ?? 0;
    if (used >= MAX_PER_FAMILY) continue;
    perFamily.set(family, used + 1);
    selected.push(p);
    if (selected.length >= MAX_PATTERNS) break;
  }
  return selected;
}

/** Weeks since a reference date, used by the reflection cadence. */
export function weeksSince(iso: string, now: Date = new Date()): number {
  return Math.floor(daysBetween(new Date(iso), now) / 7);
}
