/**
 * Habit health.
 *
 * A raw `Habit` records what happened. What Xana needs before she speaks is the
 * judgement on top: is this on pace for its weekly target, and is the streak
 * genuinely in danger right now? "In danger" is the interesting one — a streak
 * should not read as broken before the day is over, and it should not read as
 * safe on a Sunday night when the weekly target is still unmet.
 */

import type { Habit, HabitWithHealth, HealthSample } from "../core/types";
import { addDays, daysBetween, startOfDay, startOfWeek, toDateKey } from "../core/time";

export function habitWithHealth(habit: Habit, now: Date = new Date()): HabitWithHealth {
  const weekStart = startOfWeek(now);
  const weekStartKey = toDateKey(weekStart);
  const thisWeek = habit.completions.filter((d) => d >= weekStartKey).length;
  const onPace = thisWeek >= expectedByNow(habit.targetPerWeek, now);

  // Days left in the week including today — today still counts as available.
  const dow = (now.getDay() + 6) % 7; // Mon = 0
  const daysLeft = 7 - dow;
  const remainingNeeded = Math.max(0, habit.targetPerWeek - thisWeek);
  const loggedToday = habit.completions.includes(toDateKey(now));

  /*
   * At risk means the streak is genuinely one missed day from breaking: today
   * is unlogged, and even if you log today the remaining days in the week can
   * no longer absorb the rest. Merely lagging the pro-rata pace early in the
   * week is not risk — flagging that would cry wolf every Monday.
   */
  const reachableAfterToday = remainingNeeded - 1;
  const daysAfterToday = daysLeft - 1;
  const atRisk =
    !loggedToday &&
    habit.streak >= 1 &&
    remainingNeeded > 0 &&
    reachableAfterToday >= daysAfterToday;

  return { ...habit, thisWeek, onPace, atRisk };
}

/** Pro-rata expectation: how many completions by this point in the week. */
function expectedByNow(targetPerWeek: number, now: Date): number {
  const dow = (now.getDay() + 6) % 7; // Mon = 0
  const fraction = (dow + 1) / 7;
  // Round down so a habit is never "behind" on the strength of the current day.
  return Math.floor(targetPerWeek * fraction + 1e-9);
}

export function habitsWithHealth(habits: Habit[], now: Date = new Date()): HabitWithHealth[] {
  return habits.map((h) => habitWithHealth(h, now));
}

/**
 * Weekly consistency 0..1 across all habits — the number behind a trend line.
 * Recent weeks are weighted equally; a single missed habit does not dominate.
 */
export function consistency(habits: Habit[], weeks = 4, now: Date = new Date()): number {
  if (habits.length === 0) return 0;
  let hit = 0;
  let possible = 0;

  for (let w = 0; w < weeks; w++) {
    const start = startOfDay(addDays(startOfWeek(now), -7 * w));
    const startKey = toDateKey(start);
    const endKey = toDateKey(addDays(start, 6));
    for (const h of habits) {
      const done = h.completions.filter((d) => d >= startKey && d <= endKey).length;
      hit += Math.min(done, h.targetPerWeek);
      possible += h.targetPerWeek;
    }
  }
  return possible === 0 ? 0 : Math.min(1, hit / possible);
}

/** How many of the last `days` had any health sample — data coverage. */
export function healthCoverage(health: HealthSample[], days = 7, now: Date = new Date()): number {
  if (health.length === 0) return 0;
  const cutoff = toDateKey(addDays(now, -(days - 1)));
  const covered = new Set(health.filter((h) => h.date >= cutoff).map((h) => h.date));
  return Math.min(1, covered.size / days);
}

/** Sleep debt in hours against a baseline, over the trailing window. */
export function sleepDebt(health: HealthSample[], baselineHours = 7.5, days = 7): number {
  const cutoff = toDateKey(addDays(new Date(), -(days - 1)));
  return health
    .filter((h) => h.date >= cutoff)
    .reduce((acc, h) => acc + Math.max(0, baselineHours - (h.sleepHours ?? baselineHours)), 0);
}

/** Most recent sample, by day. */
export function latestHealth(health: HealthSample[]): HealthSample | undefined {
  if (health.length === 0) return undefined;
  return [...health].sort((a, b) => a.date.localeCompare(b.date))[health.length - 1];
}

/** Direction of a short trailing window: -1 worsening, 0 flat, 1 improving. */
export function moodTrend(health: HealthSample[], days = 7): HealthSample["mood"][] {
  const cutoff = toDateKey(addDays(new Date(), -(days - 1)));
  return health
    .filter((h) => h.date >= cutoff && h.mood)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((h) => h.mood!);
}

export { daysBetween };
