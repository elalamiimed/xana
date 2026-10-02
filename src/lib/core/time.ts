/**
 * Time + id helpers.
 *
 * Calendar days belong to the app, not to the machine it runs on: every date
 * key, day boundary and clock reading below is `zone.ts`'s, whose zone is
 * Asia/Shanghai. This file used to build date keys from `getFullYear()` and
 * decide `partOfDay` from `getHours()`, which made the same instant two
 * different days depending on which process asked.
 *
 * It stays server side: `node:crypto` is here for id generation, so client
 * components import `zone.ts` directly.
 */

import { randomUUID } from "node:crypto";

import {
  addDaysInZone,
  clockInZone,
  dateKeyInZone,
  dayLabelInZone,
  daysBetweenInZone,
  endOfDayInZone,
  fromDateKeyInZone,
  hourInZone,
  startOfDayInZone,
  weekdayIndexInZone,
} from "./zone";

export function uid(prefix = ""): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id.replace(/-/g, "").slice(0, 16)}` : id;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** The app's calendar date as YYYY-MM-DD (never UTC-shifted, never the host's). */
export function toDateKey(d: Date = new Date()): string {
  return dateKeyInZone(d);
}

export function fromDateKey(key: string): Date {
  return fromDateKeyInZone(key);
}

export function startOfDay(d: Date = new Date()): Date {
  return startOfDayInZone(d);
}

export function endOfDay(d: Date = new Date()): Date {
  return endOfDayInZone(d);
}

export function addDays(d: Date, days: number): Date {
  return addDaysInZone(d, days);
}

/** Minutes are an absolute span, so this one does not consult a calendar. */
export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

/** Monday-start week containing `d`. */
export function startOfWeek(d: Date = new Date()): Date {
  return addDaysInZone(startOfDayInZone(d), -weekdayIndexInZone(d));
}

export function startOfMonth(d: Date = new Date()): Date {
  return fromDateKeyInZone(`${dateKeyInZone(d).slice(0, 7)}-01`);
}

export function daysBetween(a: Date, b: Date): number {
  return daysBetweenInZone(a, b);
}

function toInstant(iso: string | Date): Date {
  return typeof iso === "string" ? new Date(iso) : iso;
}

export function formatTime(iso: string | Date): string {
  return clockInZone(toInstant(iso));
}

export function formatDay(iso: string | Date): string {
  return dayLabelInZone(toInstant(iso));
}

export function minutesBetween(a: Date | string, b: Date | string): number {
  const da = typeof a === "string" ? new Date(a) : a;
  const db = typeof b === "string" ? new Date(b) : b;
  return Math.round((db.getTime() - da.getTime()) / 60_000);
}

export function partOfDay(d: Date = new Date()): "night" | "morning" | "afternoon" | "evening" {
  const h = hourInZone(d);
  if (h < 5) return "night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}

export function isoWeekKey(d: Date = new Date()): string {
  // The Thursday of the week names the ISO year, which is what makes the last
  // days of December belong to the next year's week 1 rather than week 53.
  const thursday = addDaysInZone(startOfDayInZone(d), 3 - weekdayIndexInZone(d));
  const year = dateKeyInZone(thursday).slice(0, 4);
  const week =
    Math.floor(daysBetweenInZone(fromDateKeyInZone(`${year}-01-01`), thursday) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** "3h 20m", "45m", "2d" — compact, the way Xana talks. */
export function humanDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Recency decay: 1.0 today, ~0.5 at `halfLifeDays`. */
export function recencyWeight(iso: string, halfLifeDays = 21): number {
  const age = Math.max(0, daysBetween(new Date(iso), new Date()));
  return 0.5 ** (age / halfLifeDays);
}
