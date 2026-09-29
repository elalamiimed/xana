/**
 * Reflections.
 *
 * A weekly or monthly reflection assembled from what actually happened —
 * completions, milestones, habit consistency, focus volume, energy — and then
 * written in Xana's voice as three short paragraphs, not a report. The
 * generator is deterministic and local: no model call, so it works offline and
 * reads the same every time you open it.
 *
 * Structure is fixed: what moved, what didn't, what the numbers say about you.
 */

import type {
  FocusSession,
  Goal,
  GoalProgress,
  Habit,
  HealthSample,
  Reflection,
  Task,
} from "../core/types";
import { consistency, sleepDebt } from "./habits";
import { addDays, daysBetween, round, startOfMonth, startOfWeek, toDateKey, uid } from "../core/time";

export interface ReflectionInputs {
  tasks: Task[];
  goals: Array<{ goal: Goal; progress: GoalProgress }>;
  habits: Habit[];
  focus: FocusSession[];
  health: HealthSample[];
  periodStart: Date;
  periodEnd: Date;
  period: "weekly" | "monthly";
}

function inRange(iso: string | undefined, from: Date, to: Date): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= from.getTime() && t < to.getTime();
}

export function buildReflection(input: ReflectionInputs): Reflection {
  const { periodStart, periodEnd } = input;

  const completed = input.tasks.filter((t) => t.status === "done" && inRange(t.completedAt, periodStart, periodEnd));
  const created = input.tasks.filter((t) => inRange(t.createdAt, periodStart, periodEnd));
  const milestones = input.goals.flatMap(({ goal }) =>
    goal.milestones
      .filter((m) => m.done && inRange(m.completedAt, periodStart, periodEnd))
      .map((m) => ({ title: m.title, goal: goal.title })),
  );
  const focusSessions = input.focus.filter((f) => f.completed && inRange(f.startedAt, periodStart, periodEnd));
  const focusMinutes = focusSessions.reduce((acc, f) => acc + f.minutes, 0);
  const consistencyScore = consistency(input.habits, input.period === "weekly" ? 1 : 4, periodEnd);
  const debt = sleepDebt(
    input.health.filter((h) => h.date >= toDateKey(periodStart) && h.date <= toDateKey(periodEnd)),
    7.5,
    Math.max(1, daysBetween(periodStart, periodEnd)),
  );

  const highlights: string[] = [];
  if (completed.length > 0) highlights.push(`${completed.length} tasks completed`);
  if (milestones.length > 0) highlights.push(`${milestones.length} milestones reached`);
  if (focusMinutes > 0) highlights.push(`${round(focusMinutes / 60, 1)}h focused`);
  if (consistencyScore > 0) highlights.push(`${Math.round(consistencyScore * 100)}% habit consistency`);

  /* --- Paragraph 1: what moved. --- */
  const moved: string[] = [];
  if (completed.length > 0) {
    const named = completed
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 2)
      .map((t) => `"${t.title}"`);
    moved.push(`${completed.length} thing${completed.length === 1 ? "" : "s"} finished${named.length ? `, including ${named.join(" and ")}` : ""}.`);
  }
  if (milestones.length > 0) {
    moved.push(`${milestones.length} milestone${milestones.length === 1 ? "" : "s"} closed — ${milestones.slice(0, 2).map((m) => m.title).join(", ")}.`);
  }
  if (focusMinutes >= 60) {
    moved.push(`${round(focusMinutes / 60, 1)} hours of real focus across ${focusSessions.length} session${focusSessions.length === 1 ? "" : "s"}.`);
  }
  const paraOne = moved.length > 0 ? moved.join(" ") : `Very little closed out. Some weeks are holding patterns.`;

  /* --- Paragraph 2: what didn't. --- */
  const stalled = input.goals.filter((g) => g.progress.pace === "stalled" || g.progress.pace === "slipping");
  const slipped = input.tasks.filter((t) => t.due && new Date(t.due) < periodEnd && t.status !== "done");
  const didNot: string[] = [];
  if (stalled.length > 0) {
    didNot.push(`${stalled.map((s) => `"${s.goal.title}"`).join(" and ")} ${stalled.length === 1 ? "has" : "have"} not moved${stalled[0].progress.note ? ` — ${stalled[0].progress.note.toLowerCase()}` : ""}.`);
  }
  if (slipped.length > 0) didNot.push(`${slipped.length} item${slipped.length === 1 ? "" : "s"} went past due.`);
  if (debt > 4) didNot.push(`Sleep debt reached ${round(debt, 1)} hours.`);
  const paraTwo = didNot.length > 0 ? didNot.join(" ") : `Nothing slipped. The debts are all paid.`;

  /* --- Paragraph 3: what the numbers say. --- */
  const observations: string[] = [];
  if (created.length > 0 && completed.length > 0) {
    const ratio = completed.length / created.length;
    if (ratio >= 1) observations.push(`You finished more than you took on. That is the rare direction.`);
    else if (ratio < 0.5) observations.push(`${created.length} came in, ${completed.length} went out. The list is growing faster than you are clearing it.`);
    else observations.push(`Roughly in balance: ${created.length} in, ${completed.length} out.`);
  }
  if (consistencyScore >= 0.8) observations.push(`Habits held at ${Math.round(consistencyScore * 100)}%. Whatever the system is, it is working.`);
  else if (consistencyScore > 0 && consistencyScore < 0.5) observations.push(`Habit consistency is ${Math.round(consistencyScore * 100)}%. The targets may be above what the week can carry.`);
  if (focusSessions.length >= 5) observations.push(`Focus came in many small pieces rather than a few long ones.`);
  else if (focusMinutes >= 300) observations.push(`Focus came in long blocks. That is where the depth is.`);
  const paraThree = observations.length > 0 ? observations.join(" ") : `Not enough data yet to say anything useful about the shape of your weeks.`;

  return {
    id: uid("refl"),
    period: input.period,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    body: [paraOne, paraTwo, paraThree].join("\n\n"),
    highlights,
    createdAt: new Date().toISOString(),
  };
}

export function weeklyReflectionInputs(
  base: Omit<ReflectionInputs, "period" | "periodStart" | "periodEnd">,
  now: Date = new Date(),
): ReflectionInputs {
  // The week just gone, not the week in progress.
  const thisWeek = startOfWeek(now);
  return { ...base, period: "weekly", periodStart: addDays(thisWeek, -7), periodEnd: thisWeek };
}

export function monthlyReflectionInputs(
  base: Omit<ReflectionInputs, "period" | "periodStart" | "periodEnd">,
  now: Date = new Date(),
): ReflectionInputs {
  const thisMonth = startOfMonth(now);
  const lastMonth = startOfMonth(addDays(thisMonth, -1));
  return { ...base, period: "monthly", periodStart: lastMonth, periodEnd: thisMonth };
}

/** True when enough time has passed that a new reflection is warranted. */
export function shouldReflect(
  period: "weekly" | "monthly",
  lastReflectionAt: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastReflectionAt) return true;
  const days = daysBetween(new Date(lastReflectionAt), now);
  return period === "weekly" ? days >= 7 : days >= 28;
}
