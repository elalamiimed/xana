/**
 * Proactive nudges.
 *
 * The difference between an assistant and a notification stream is restraint.
 * Xana raises at most a handful of things, ordered by what actually changes
 * the day, and every nudge carries the action that would resolve it so the UI
 * can offer one tap instead of a conversation.
 *
 * Ordering principle: time-critical and irreversible first, then things that
 * decay if ignored, then encouragement. Never more than five.
 */

import type {
  CalendarEvent,
  Goal,
  GoalProgress,
  HabitWithHealth,
  HealthSample,
  MailSignal,
  Nudge,
  Pattern,
  Task,
  WeatherSnapshot,
} from "../core/types";
import { addDays, daysBetween, formatDay, formatTime, humanDuration, minutesBetween, toDateKey, uid } from "../core/time";
import { patternFamily } from "./patterns";

export interface NudgeInputs {
  tasks: Task[];
  events: CalendarEvent[];
  habits: HabitWithHealth[];
  goals: Array<{ goal: Goal; progress: GoalProgress }>;
  health: HealthSample[];
  weather?: WeatherSnapshot;
  mail: MailSignal[];
  patterns: Pattern[];
  freeMinutes: number;
  now?: Date;
}

function nudge(
  tone: Nudge["tone"],
  text: string,
  priority: number,
  action?: Nudge["action"],
): Nudge {
  return { id: uid("nudge"), tone, text, priority, action };
}

/** Something starting soon that you may not have noticed. */
function imminentEvent(input: NudgeInputs, now: Date): Nudge | undefined {
  const soon = input.events
    .filter((e) => !e.allDay)
    .map((e) => ({ e, startsIn: minutesBetween(now, new Date(e.start)) }))
    .filter((x) => x.startsIn > 0 && x.startsIn <= 45)
    .sort((a, b) => a.startsIn - b.startsIn)[0];
  if (!soon) return undefined;

  const { e, startsIn } = soon;
  const where = e.location ? ` in ${e.location}` : "";
  return nudge("warn", `${e.title}${where} — ${humanDuration(startsIn)} away, ${formatTime(e.start)}.`, 100);
}

/** An event that has already started. */
function inProgress(input: NudgeInputs, now: Date): Nudge | undefined {
  const live = input.events
    .filter((e) => !e.allDay)
    .find((e) => new Date(e.start) <= now && new Date(e.end) > now);
  if (!live) return undefined;
  const left = minutesBetween(now, new Date(live.end));
  return nudge("info", `${live.title} is running. ${humanDuration(left)} left.`, 95);
}

/** Mail that is waiting on you and matters. */
function mailWaiting(input: NudgeInputs): Nudge | undefined {
  const waiting = input.mail.filter((m) => m.needsReply).sort((a, b) => b.importance - a.importance)[0];
  if (!waiting) return undefined;
  return nudge("suggest", `${waiting.from} is waiting on you — "${waiting.subject}".`, 70);
}

/** Overdue work, in order of how late. */
function overdueTasks(input: NudgeInputs, now: Date): Nudge | undefined {
  const overdue = input.tasks.filter((t) => t.due && new Date(t.due) < now && t.status !== "done");
  if (overdue.length === 0) return undefined;
  const worst = overdue.sort((a, b) => a.due!.localeCompare(b.due!))[0];
  const days = Math.abs(daysBetween(now, new Date(worst.due!)));
  const label = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return nudge(
    "warn",
    overdue.length === 1
      ? `"${worst.title}" was due ${label}.`
      : `${overdue.length} things overdue, oldest is "${worst.title}" from ${label}.`,
    88,
    { type: "complete_task", taskId: worst.id },
  );
}

/** A streak that breaks if today passes without a log. */
function streakRisk(input: NudgeInputs): Nudge | undefined {
  const risk = input.habits.filter((h) => h.atRisk && h.streak >= 3).sort((a, b) => b.streak - a.streak)[0];
  if (!risk) return undefined;
  return nudge(
    "suggest",
    `${risk.name} is at ${risk.streak} days. Log it and it holds.`,
    76,
    { type: "log_habit", habitId: risk.id },
  );
}

/** Weather that should change what you wear or carry. */
function weatherWarning(input: NudgeInputs): Nudge | undefined {
  const w = input.weather;
  if (!w || w.synthetic) return undefined;
  if (w.precipitationChance >= 0.55) {
    return nudge("info", `${Math.round(w.precipitationChance * 100)}% chance of rain in ${w.location}. Take the coat.`, 60);
  }
  if (w.highC - w.lowC >= 12) {
    return nudge("info", `Big swing today — ${w.lowC}° to ${w.highC}°. Layers.`, 45);
  }
  if (w.temperatureC <= 2) {
    return nudge("info", `${w.temperatureC}° and ${w.condition}. It's properly cold.`, 50);
  }
  return undefined;
}

/** Sleep debt that has crossed the line from "tired" to "costly". */
function sleepDebt(input: NudgeInputs): Nudge | undefined {
  const recent = input.health.slice(-7);
  if (recent.length < 3) return undefined;
  const debt = recent.reduce((acc, h) => acc + Math.max(0, 7.5 - (h.sleepHours ?? 7.5)), 0);
  if (debt < 5) return undefined;
  return nudge("warn", `${debt.toFixed(1)}h of sleep debt this week. Tonight is the cheapest fix.`, 72);
}

/** A goal milestone due soon and not yet done. */
function milestoneDue(input: NudgeInputs, now: Date): Nudge | undefined {
  const pending = input.goals
    .flatMap(({ goal }) =>
      (goal.milestones ?? [])
        .filter((m) => !m.done && m.due)
        .map((m) => ({ m, goalTitle: goal.title, days: daysBetween(now, new Date(`${m.due!.slice(0, 10)}T00:00:00`)) })),
    )
    .filter((x) => x.days >= 0 && x.days <= 3)
    .sort((a, b) => a.days - b.days)[0];
  if (!pending) return undefined;

  const { m, goalTitle, days } = pending;
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : formatDay(m.due!);
  return nudge(
    "suggest",
    `"${m.title}" is due ${when} on ${goalTitle}.`,
    74,
    { type: "complete_milestone", milestoneId: m.id },
  );
}

/** Celebrate a genuinely finished thing — once, and only if it's real. */
function celebrate(input: NudgeInputs, now: Date): Nudge | undefined {
  const justDone = input.tasks.filter((t) => {
    if (!t.completedAt) return false;
    const age = (now.getTime() - new Date(t.completedAt).getTime()) / 3_600_000;
    return age <= 6 && t.priority <= 2;
  });
  if (justDone.length === 0) return undefined;
  const t = justDone[0];
  return nudge("celebrate", `"${t.title}" is done. That was one of the real ones.`, 40);
}

/** Free time worth naming — only when it is substantial and unscheduled. */
function freeBlock(input: NudgeInputs): Nudge | undefined {
  if (input.freeMinutes < 90 || input.events.length === 0) return undefined;
  return nudge("info", `${humanDuration(input.freeMinutes)} unscheduled today.`, 30);
}

/** Carry over yesterday's unfinished priority-1 work. */
function carriedOver(input: NudgeInputs, now: Date): Nudge | undefined {
  const stale = input.tasks.filter(
    (t) => t.priority === 1 && t.status !== "done" && daysBetween(new Date(t.createdAt), now) >= 5,
  );
  if (stale.length === 0) return undefined;
  return nudge("suggest", `"${stale[0].title}" has been top priority for ${daysBetween(new Date(stale[0].createdAt), now)} days. Finish it or drop it.`, 66);
}

/**
 * A pattern worth acting on now, promoted to a nudge.
 *
 * Only families whose action is not already covered by a dedicated nudge source
 * are promoted. A habit pattern's suggestion ("log it today") duplicates the
 * streak-risk nudge, so promoting it would just say the same thing twice.
 */
const PROMOTABLE_FAMILIES = new Set(["sleep", "calendar", "focus"]);

function patternAction(input: NudgeInputs): Nudge | undefined {
  const p = input.patterns.find(
    (x) => x.suggestion && x.confidence >= 0.7 && PROMOTABLE_FAMILIES.has(patternFamily(x.key)),
  );
  if (!p?.suggestion) return undefined;
  return nudge("suggest", p.suggestion, 55, p.action);
}

const SOURCES = [
  imminentEvent,
  inProgress,
  overdueTasks,
  streakRisk,
  milestoneDue,
  mailWaiting,
  sleepDebt,
  carriedOver,
  weatherWarning,
  patternAction,
  celebrate,
  freeBlock,
];

export function buildNudges(input: NudgeInputs): Nudge[] {
  const now = input.now ?? new Date();
  const out: Nudge[] = [];
  for (const source of SOURCES) {
    try {
      const n = source(input, now);
      if (n) out.push(n);
    } catch {
      // A nudge source must never take the life state down with it.
    }
  }

  // Two sources can describe the same underlying thing — the habit-risk source
  // and a habit pattern, for instance. Both carry the same action, so keep the
  // higher-priority wording rather than saying it twice.
  const byAction = new Set<string>();
  const deduped: Nudge[] = [];
  for (const n of out) {
    const actionKey = n.action ? n.action.type : undefined;
    // Only collapse by action when the wording also overlaps; two genuinely
    // different suggestions rarely share both.
    const textKey = fingerprint(n.text);
    if (byAction.has(`${actionKey}|${textKey}`)) continue;
    if (actionKey) byAction.add(`${actionKey}|${textKey}`);
    if (deduped.some((d) => fingerprint(d.text) === textKey)) continue;
    deduped.push(n);
  }

  return deduped.sort((a, b) => b.priority - a.priority).slice(0, 5);
}

/**
 * Loose fingerprint for near-duplicate nudges. Strips digits and punctuation so
 * "Meditation is at 25 days" and "Meditation is at 26 days" collapse together.
 */
function fingerprint(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  return [...new Set(words)].sort().slice(0, 6).join(" ");
}

/** The single line at the top of everything — what this moment is. */
export function headlineFor(input: {
  partOfDay: string;
  events: CalendarEvent[];
  tasks: Task[];
  nudges: Nudge[];
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const critical = input.nudges.find((n) => n.tone === "warn");
  if (critical) return critical.text;

  const next = input.events
    .filter((e) => !e.allDay && new Date(e.start) > now)
    .sort((a, b) => a.start.localeCompare(b.start))[0];

  if (next && minutesBetween(now, new Date(next.start)) <= 120) {
    return `${next.title} at ${formatTime(next.start)}.`;
  }

  const dueToday = input.tasks.filter((t) => t.due && toDateKey(new Date(t.due)) === toDateKey(now) && t.status !== "done");
  if (dueToday.length > 0) {
    return dueToday.length === 1
      ? `One thing due today: ${dueToday[0].title}.`
      : `${dueToday.length} things due today.`;
  }

  if (input.events.length === 0 && input.tasks.length === 0) return `Nothing scheduled. A clear day.`;

  switch (input.partOfDay) {
    case "morning": return `Morning. ${input.tasks.length} open, nothing pressing.`;
    case "afternoon": return `Afternoon. The day is still yours.`;
    case "evening": return `Evening. Winding down.`;
    default: return `Late. Whatever this is, it can probably wait until morning.`;
  }
}

/** Tomorrow's shape, used by the evening briefing. */
export function tomorrowSummary(events: CalendarEvent[], now: Date = new Date()): string {
  const tomorrow = toDateKey(addDays(now, 1));
  const list = events.filter((e) => toDateKey(new Date(e.start)) === tomorrow);
  if (list.length === 0) return "Tomorrow is clear.";
  const first = list[0];
  return `Tomorrow: ${list.length} thing${list.length === 1 ? "" : "s"}, first at ${formatTime(first.start)}.`;
}
