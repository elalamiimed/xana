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

  const remaining = risk.targetPerWeek - risk.thisWeek;
  const name = risk.name;

  // One line for every streak told the user nothing about which streak it was.
  // A record-length run and a three-day one are different losses, and a week
  // that needs one more log is a different ask from a week that needs four.
  const text =
    risk.streak >= risk.longestStreak && risk.streak >= 14
      ? `${name} is at ${risk.streak} days — your longest run. Logging it today keeps that.`
      : remaining <= 1
        ? `One ${name.toLowerCase()} today and the ${risk.streak}-day run holds.`
        : `${name} is at ${risk.streak} days and needs ${remaining} this week.`;

  return nudge("suggest", text, 76, { type: "log_habit", habitId: risk.id });
}

/** Weather that should change what you wear or carry. */
function weatherWarning(input: NudgeInputs): Nudge | undefined {
  const w = input.weather;
  if (!w || w.synthetic) return undefined;

  // These are readings, not advice, and they read that way now. "Take the
  // coat" and "Layers." were instructions attached to a measurement, which is
  // the same mistake as a pattern telling the user what to do about a number.
  const wet = Math.round(w.precipitationChance * 100);
  if (w.precipitationChance >= 0.55) {
    return nudge(
      "info",
      wet >= 80
        ? `Rain in ${w.location} — ${wet}% chance.`
        : `${wet}% chance of rain in ${w.location}.`,
      60,
    );
  }
  if (w.highC - w.lowC >= 12) {
    return nudge("info", `A ${w.highC - w.lowC}° swing today, ${w.lowC}° to ${w.highC}°.`, 45);
  }
  if (w.temperatureC <= 2) {
    return nudge("info", `${w.temperatureC}° and ${w.condition} in ${w.location}.`, 50);
  }
  return undefined;
}

/** Sleep debt that has crossed the line from "tired" to "costly". */
function sleepDebt(input: NudgeInputs): Nudge | undefined {
  const recent = input.health.slice(-7);
  if (recent.length < 3) return undefined;
  const debt = recent.reduce((acc, h) => acc + Math.max(0, 7.5 - (h.sleepHours ?? 7.5)), 0);
  if (debt < 5) return undefined;

  // How big the debt is changes what it is worth saying. Five hours is a bad
  // week; fifteen is a fortnight of it, and "tonight is the cheapest fix" is
  // advice for the first and not the second.
  const text =
    debt >= 12
      ? `${debt.toFixed(1)}h of sleep debt. That is not one early night, it is a fortnight of them.`
      : debt >= 8
        ? `${debt.toFixed(1)}h down this week. Two good nights would clear most of it.`
        : `${debt.toFixed(1)}h of sleep debt. Tonight is the cheapest place to start.`;

  return nudge("warn", text, 72);
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

  // "That was one of the real ones" for a five-minute chore is the kind of
  // praise that teaches a user to ignore praise. How long it had been open is
  // the thing that makes it worth saying, and it is knowable.
  const age = daysBetween(new Date(t.createdAt), now);
  const text =
    age >= 14
      ? `"${t.title}" is done — open for ${age} days. That one has been sitting there a while.`
      : justDone.length > 1
        ? `"${t.title}" is done, and ${justDone.length - 1} more with it.`
        : `"${t.title}" is done.`;

  return nudge("celebrate", text, 40);
}

/** Free time worth naming — only when it is substantial and unscheduled. */
function freeBlock(input: NudgeInputs): Nudge | undefined {
  if (input.freeMinutes < 90 || input.events.length === 0) return undefined;

  // Three hours free is not the same offer as ninety minutes, and the sentence
  // should not pretend otherwise: one is a gap between things, the other is
  // enough to finish something.
  const text =
    input.freeMinutes >= 240
      ? `${humanDuration(input.freeMinutes)} unscheduled — enough to finish something real.`
      : input.freeMinutes >= 150
        ? `${humanDuration(input.freeMinutes)} free. Worth claiming before it fills.`
        : `${humanDuration(input.freeMinutes)} between things.`;

  return nudge("info", text, 30);
}

/** Carry over yesterday's unfinished priority-1 work. */
function carriedOver(input: NudgeInputs, now: Date): Nudge | undefined {
  const stale = input.tasks.filter(
    (t) => t.priority === 1 && t.status !== "done" && daysBetween(new Date(t.createdAt), now) >= 5,
  );
  if (stale.length === 0) return undefined;

  const oldest = stale.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )[0];
  const age = daysBetween(new Date(oldest.createdAt), now);

  // Two weeks at the top of a list is a different situation from five days:
  // one is a busy stretch, the other is a decision being avoided, and the
  // nudge is the only place that can say so without nagging.
  const text =
    age >= 14
      ? `"${oldest.title}" has been your top priority for ${age} days. Either it is not actually the priority, or something else is.`
      : `"${oldest.title}" has sat at the top for ${age} days.`;

  return nudge("suggest", text, 66);
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
  // 0.5, down from 0.7. The threshold moved because the figure did: pattern
  // confidences are now derived from sample size (a Wilson lower bound) rather
  // than partly asserted, so the whole scale sits lower and a 0.7 cut would
  // have silently stopped promoting patterns that are just as sound as before.
  const p = input.patterns.find(
    (x) => x.suggestion && x.confidence >= 0.5 && PROMOTABLE_FAMILIES.has(patternFamily(x.key)),
  );
  if (!p?.suggestion) return undefined;
  return nudge("suggest", p.suggestion, 55, p.action);
}

/**
 * Asking the user for their energy, twice a day.
 *
 * Every other source here reads something. This one asks, because the reading
 * it wants does not exist anywhere else — sleep, load and the circadian curve
 * can be inferred, but "how much have you actually got" is a fact only the
 * user holds, and it is the one number that can disagree with the forecast.
 *
 * Twice, not more, and the limit is structural rather than a cooldown counter:
 * the nudge only exists while the newest reading is stale, so answering it is
 * what makes it stop. There is no separate bookkeeping to fall out of step
 * with the data, which is the failure mode a cooldown would have.
 *
 * It fires in the middle of each half of the waking day. Asking at 06:00 is
 * asking before there is anything to report; asking at 14:00 and 20:00 catches
 * the shape of the day, which is what makes two readings worth more than one.
 */
function energyCheckIn(input: NudgeInputs, now: Date): Nudge | undefined {
  const hour = now.getHours();

  // The two windows. Outside them, nothing.
  const evening = hour >= 19 && hour < 23;
  const afternoon = hour >= 13 && hour < 16;
  if (!evening && !afternoon) return undefined;

  const latest = input.health[input.health.length - 1];
  const at = latest?.energyAt ? new Date(latest.energyAt) : undefined;
  const hoursSince = at ? (now.getTime() - at.getTime()) / 3_600_000 : Infinity;
  if (hoursSince < 7) return undefined;

  // Say why it is being asked, from the day itself. A bare "rate your energy"
  // is a form; this is a question with a reason attached.
  const events = input.events.filter((e) => !e.allDay && new Date(e.end) > now);
  const nextAt = events.sort((a, b) => a.start.localeCompare(b.start))[0];
  const why = nextAt
    ? `${nextAt.title} is still ahead`
    : events.length > 0
      ? `${events.length} still to get through`
      : "the rest of today is yours";

  return nudge(
    "suggest",
    hoursSince === Infinity
      ? `You have not told me your energy today — ${why}. A number, 1 to 5.`
      : `How is your energy now? ${why}. A number, 1 to 5.`,
    58,
  );
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
  energyCheckIn,
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
