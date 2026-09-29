/**
 * Goal progress and pace.
 *
 * Progress is milestone-derived unless explicitly overridden. Pace compares
 * elapsed time against elapsed work, which is the only honest way to say
 * "slipping" — a goal 40% done with 90% of its window gone is not on track,
 * however healthy 40% sounds on its own.
 */

import type { Goal, GoalProgress } from "../core/types";
import { daysBetween, round, startOfDay } from "../core/time";

const PACE_NOTES: Record<GoalProgress["pace"], string> = {
  ahead: "Ahead of the pace you set.",
  "on-track": "Tracking to plan.",
  slipping: "Slipping — behind where the calendar says you should be.",
  stalled: "Nothing has moved in a while.",
};

export function computeGoalProgress(goal: Goal, now: Date = new Date()): GoalProgress {
  const total = goal.milestones.length;
  const done = goal.milestones.filter((m) => m.done).length;

  // Without milestones, fall back to an explicit override, then to 0.
  const progress =
    total > 0
      ? done / total
      : typeof goal.progressOverride === "number"
        ? Math.min(1, Math.max(0, goal.progressOverride))
        : 0;

  const daysRemaining = goal.targetDate
    ? daysBetween(now, new Date(`${goal.targetDate.slice(0, 10)}T00:00:00`))
    : undefined;

  /* --- Staleness: how long since anything actually moved. --- */
  /**
   * Three sources, most explicit first.
   *
   * `lastTouchedAt` is the user asserting that work happened, which is the
   * only signal available for a goal with no milestones. Completed
   * milestones are the automatic signal. Creation date is the floor.
   *
   * Without the explicit stamp, a milestone-free goal is permanently
   * "stalled" — its newest completion never exists, so the measurement falls
   * back to the day it was written down.
   */
  const lastTouched = [
    goal.lastTouchedAt ? new Date(goal.lastTouchedAt).getTime() : 0,
    ...goal.milestones
      .filter((m) => m.done && m.completedAt)
      .map((m) => new Date(m.completedAt as string).getTime()),
  ]
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => b - a)[0];
  const daysSinceProgress = lastTouched
    ? daysBetween(new Date(lastTouched), now)
    : daysBetween(new Date(goal.createdAt), now);

  /* --- Time elapsed against work done. --- */
  const totalDays = goal.targetDate
    ? Math.max(1, daysBetween(new Date(goal.createdAt), new Date(`${goal.targetDate.slice(0, 10)}T00:00:00`)))
    : undefined;
  const elapsedFraction =
    totalDays !== undefined
      ? Math.min(1, Math.max(0, (totalDays - Math.max(0, daysRemaining ?? 0)) / totalDays))
      : undefined;

  let pace: GoalProgress["pace"];
  if (progress >= 1) {
    pace = "ahead";
  } else if (daysSinceProgress >= 21) {
    pace = "stalled";
  } else if (elapsedFraction !== undefined) {
    const delta = progress - elapsedFraction;
    if (delta < -0.12) pace = "slipping";
    else if (delta >= 0.15 && milestoneOverdue(goal, now)) pace = "slipping";
    else if (delta >= 0.15) pace = "ahead";
    else if (delta >= -0.12) pace = "on-track";
    else pace = "slipping";
  } else {
    // No target date: pace is inferred from momentum alone.
    pace = daysSinceProgress <= 10 ? "on-track" : progress > 0 ? "slipping" : "stalled";
  }

  let note = PACE_NOTES[pace];
  if (pace === "slipping" && daysRemaining !== undefined && daysRemaining >= 0) {
    note = `${Math.round(progress * 100)}% done with ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left.`;
  } else if (pace === "stalled" && daysSinceProgress > 0) {
    note = `Last movement ${daysSinceProgress} days ago.`;
  } else if (pace === "ahead" && progress >= 1) {
    note = "Complete.";
  }

  return {
    goalId: goal.id,
    progress: round(progress, 3),
    milestonesDone: done,
    milestonesTotal: total,
    pace,
    daysRemaining,
    note,
  };
}

export function goalsWithProgress(goals: Goal[], now: Date = new Date()): Array<{ goal: Goal; progress: GoalProgress }> {
  return goals.map((goal) => ({ goal, progress: computeGoalProgress(goal, now) }));
}

/**
 * True when a milestone is past its due date. This is what stops an unfinished
 * goal from reading as "ahead": raw progress can look healthy purely because
 * the hard milestones are the ones still outstanding.
 */
function milestoneOverdue(goal: Goal, now: Date): boolean {
  return goal.milestones.some((m) => !m.done && m.due && new Date(`${m.due.slice(0, 10)}T23:59:59`) < now);
}

/** Weighted roll-up across active goals, for a single number when one is needed. */
export function overallProgress(items: Array<{ progress: GoalProgress }>): number {
  if (items.length === 0) return 0;
  return round(items.reduce((acc, i) => acc + i.progress.progress, 0) / items.length, 3);
}

/** Days elapsed since a date, floored at zero. */
export function daysSince(iso: string, now: Date = new Date()): number {
  return Math.max(0, daysBetween(startOfDay(new Date(iso)), now));
}
