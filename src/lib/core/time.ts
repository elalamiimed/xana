/** Time + id helpers. All dates are local-time unless a function says otherwise. */

import { randomUUID } from "node:crypto";

export function uid(prefix = ""): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id.replace(/-/g, "").slice(0, 16)}` : id;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Local calendar date as YYYY-MM-DD (never UTC-shifted). */
export function toDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

export function startOfDay(d: Date = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d: Date = new Date()): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

/** Monday-start week containing `d`. */
export function startOfWeek(d: Date = new Date()): Date {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // Mon=0
  return addDays(x, -dow);
}

export function startOfMonth(d: Date = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000);
}

export function formatTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const today = startOfDay();
  const diff = daysBetween(today, d);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function minutesBetween(a: Date | string, b: Date | string): number {
  const da = typeof a === "string" ? new Date(a) : a;
  const db = typeof b === "string" ? new Date(b) : b;
  return Math.round((db.getTime() - da.getTime()) / 60_000);
}

export function partOfDay(d: Date = new Date()): "night" | "morning" | "afternoon" | "evening" {
  const h = d.getHours();
  if (h < 5) return "night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}

export function isoWeekKey(d: Date = new Date()): string {
  const x = startOfDay(d);
  const thursday = addDays(x, 3 - ((x.getDay() + 6) % 7));
  const year = thursday.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const week = Math.floor(daysBetween(jan1, thursday) / 7) + 1;
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
