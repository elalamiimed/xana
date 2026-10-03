/**
 * The calendar's geometry: pure functions, no React and no DOM.
 *
 * WHY THIS IS A MODULE OF ITS OWN
 *
 * A calendar is mostly arithmetic that is easy to get subtly wrong and
 * impossible to eyeball: which Monday a month grid starts on, how many minutes
 * from the top of a day a pointer at y=317 is, which of three overlapping
 * meetings is the narrow one, and what a drag should actually send to the
 * server. All of that is a function of numbers, so all of it lives here where
 * it can be asserted offline — `scripts/check-calendar.ts` runs the same
 * functions the browser runs, against fixed inputs, with no server and no
 * rendering. What is left in the components is wiring.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No wall-clock is read: "today" is a parameter. The calendar's days are the
 * app's days (`@/lib/core/zone`), and a function that called `new Date()`
 * internally could not be tested at a day boundary, which is the only place
 * its bugs live. Date-key arithmetic below is done in UTC for the same reason
 * it is done that way in `zone.ts`: a calendar date is the same date in every
 * zone, and subtracting two of them must not depend on how many hours the host
 * thought a day had.
 */

import {
  clockInZone,
  fromDateKeyInZone,
  instantFromWallClock,
  monthYearInZone,
  weekdayMonthDayInZone,
} from "@/lib/core/zone";
import type { CalendarEvent } from "@/lib/core/types";

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

/** The three shapes the room draws. */
export type CalendarView = "month" | "week" | "day";

export const CALENDAR_VIEWS: readonly { id: CalendarView; label: string }[] = [
  { id: "month", label: "Month" },
  { id: "week", label: "Week" },
  { id: "day", label: "Day" },
] as const;

/**
 * What every drag snaps to, in minutes.
 *
 * The single most important number in the interaction. A drag that lands on an
 * arbitrary minute produces a calendar of 14:07 meetings that the person did not
 * intend and cannot retype; a quarter hour is the granularity people actually
 * speak in ("quarter past"), and it is what Google and Notion both use.
 */
export const SLOT_MINUTES = 15;

/** Minutes in a nominal day. The real length comes from the zone. */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * The month grid is always six rows.
 *
 * Five would be enough for most months, and a grid that changed height as you
 * paged through the year would jump under the pointer — which, on a screen
 * whose whole job is that the next month is one click away, is the difference
 * between a calendar that feels solid and one that flickers.
 */
export const MONTH_ROWS = 6;
export const MONTH_GRID_DAYS = MONTH_ROWS * 7;

/**
 * How many chips a month cell shows before it counts the rest.
 *
 * Two, and the number is a promise rather than a preference: the cell's own
 * minimum height is set from what has to fit inside it (see `.cal-month-grid`),
 * and a third chip is what turns a cell from "there is more here, press the
 * count" into a box with a chip cut in half. The header's count carries the
 * whole number, so nothing is hidden — it is only deferred to the day view,
 * which is one press away.
 */
export const MONTH_CHIPS = 2;

/** The default length of something created by a click rather than a drag. */
export const DEFAULT_MINUTES = 60;

/** Nothing is drawn shorter than this, so a zero-length row is still a target. */
export const MIN_BLOCK_MINUTES = SLOT_MINUTES;

/** The tallest a single created block may be dragged to, in minutes. */
export const MAX_MINUTES = 12 * 60;

/** Pixels per hour, by viewport class. */
export function hourHeightFor(compact: boolean): number {
  return compact ? 44 : 56;
}

/* ------------------------------------------------------------------ */
/* Days, as keys                                                      */
/* ------------------------------------------------------------------ */

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when the string is a date key this module can do arithmetic on. */
export function isDateKey(value: string): boolean {
  return DATE_KEY.test(value);
}

function parts(key: string): [number, number, number] {
  const match = DATE_KEY.exec(key);
  if (!match) return [NaN, NaN, NaN];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** A UTC-midnight count of days, used only to move a date by whole days. */
function dayNumber(key: string): number {
  const [year, month, day] = parts(key);
  if (Number.isNaN(year)) return NaN;
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function keyFromDayNumber(value: number): string {
  const date = new Date(value * 86_400_000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** `key` moved by whole days. */
export function addDays(key: string, days: number): string {
  const n = dayNumber(key);
  if (Number.isNaN(n)) return key;
  return keyFromDayNumber(n + days);
}

/** The number of days in a month, 1-based month. */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * `key` moved by whole months, clamped to the end of the target month.
 *
 * The clamp is the whole reason this is not `setUTCMonth`: 31 January plus one
 * month is 3 March through the naive route, which would page a month view
 * straight past February. Clamping lands on 28 February instead, so paging
 * forward and back returns you to where you started.
 */
export function addMonths(key: string, months: number): string {
  const [year, month, day] = parts(key);
  if (Number.isNaN(year)) return key;
  const total = (year * 12 + (month - 1)) + months;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12 + 12) % 12 + 1;
  const last = daysInMonth(nextYear, nextMonth);
  return `${nextYear}-${pad(nextMonth)}-${pad(Math.min(day, last))}`;
}

/** Monday is 0 and Sunday is 6, the convention `weekdayIndexInZone` uses. */
export function weekdayIndex(key: string): number {
  const [year, month, day] = parts(key);
  if (Number.isNaN(year)) return NaN;
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (utcDay + 6) % 7;
}

/** The Monday of `key`'s week. */
export function startOfWeek(key: string): string {
  const index = weekdayIndex(key);
  if (Number.isNaN(index)) return key;
  return addDays(key, -index);
}

/** The first of `key`'s month. */
export function startOfMonth(key: string): string {
  const [year, month] = parts(key);
  if (Number.isNaN(year)) return key;
  return `${year}-${pad(month)}-01`;
}

/**
 * The 42 days a month view draws, Monday first.
 *
 * It starts on the Monday on or before the first of the month rather than on
 * the first, because a row of weekdays with a hole at its head is a calendar
 * that has to be read twice.
 */
export function monthGridDays(anchor: string): string[] {
  const first = startOfMonth(anchor);
  const lead = weekdayIndex(first);
  const start = Number.isNaN(lead) ? first : addDays(first, -lead);
  return Array.from({ length: MONTH_GRID_DAYS }, (_, index) => addDays(start, index));
}

/** The seven days of `key`'s week, Monday first. */
export function weekDays(anchor: string): string[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

/** The days a view draws, in order. */
export function daysForView(view: CalendarView, anchor: string): string[] {
  if (view === "month") return monthGridDays(anchor);
  if (view === "week") return weekDays(anchor);
  return [anchor];
}

/** The window to ask the server for: closed at both ends, by day. */
export function windowFor(view: CalendarView, anchor: string): { from: string; to: string; days: number } {
  const days = daysForView(view, anchor);
  return { from: days[0] ?? anchor, to: days[days.length - 1] ?? anchor, days: days.length };
}

/** The anchor moved by one period of the view. */
export function shiftAnchor(view: CalendarView, anchor: string, delta: number): string {
  if (view === "month") return addMonths(anchor, delta);
  if (view === "week") return addDays(anchor, 7 * delta);
  return addDays(anchor, delta);
}

/**
 * The label over the grid: "October 2026", "Oct 5 – 11, 2026", "Thursday, Oct 8".
 *
 * Built from the zone helpers, so the month a browser in another zone reads is
 * the month the server's days belong to.
 */
export function periodLabel(view: CalendarView, anchor: string, days: readonly string[]): string {
  const first = fromDateKeyInZone(days[0] ?? anchor);
  if (view === "month") return monthYearInZone(first);
  if (view === "day") return weekdayMonthDayInZone(first);
  const last = fromDateKeyInZone(days[days.length - 1] ?? anchor);
  const firstLabel = weekdayMonthDayInZone(first);
  const lastLabel = weekdayMonthDayInZone(last);
  return `${firstLabel.split(",")[1]?.trim() ?? firstLabel} – ${lastLabel}`;
}

/** The whole of a day in words, for a title attribute. */
export function dayTitle(dayKey: string): string {
  return weekdayMonthDayInZone(fromDateKeyInZone(dayKey));
}

/* ------------------------------------------------------------------ */
/* Clock readings                                                     */
/* ------------------------------------------------------------------ */

/** `"09:05"` as minutes from midnight, or null when it is not a time. */
export function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes from midnight as `"HH:MM"`, wrapping past a day rather than lying. */
export function formatClock(minutes: number): string {
  const wrapped = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/** `minutes` rounded to the nearest slot. */
export function snap(minutes: number, slot: number = SLOT_MINUTES): number {
  return Math.round(minutes / slot) * slot;
}

/** `minutes` held inside `[low, high]`. */
export function clamp(minutes: number, low: number, high: number): number {
  return Math.min(Math.max(minutes, low), high);
}

/** The instant `minutes` into a day, in the app's zone. */
export function instantFor(dayKey: string, minutes: number): Date {
  const [year, month, day] = parts(dayKey);
  if (Number.isNaN(year)) return new Date(NaN);
  return instantFromWallClock(
    { year, month, day, hour: Math.floor(minutes / 60), minute: Math.round(minutes % 60) },
  );
}

/** The clock a person reads, for that day and that many minutes in. */
export function clockLabel(dayKey: string, minutes: number): string {
  return clockInZone(instantFor(dayKey, minutes));
}

/**
 * What a drag is about to do, said in one line beside the pointer.
 *
 * This is the feedback that makes dragging feel like it is working: without it
 * the only evidence a drag has landed where you meant is the drop itself, and a
 * quarter-hour snap is invisible on a 56px hour.
 */
export function dragLabel(dayKey: string, startMin: number, durationMin: number, allDay = false): string {
  if (allDay) return `${dayTitle(dayKey)} · all day`;
  const from = clockLabel(dayKey, startMin);
  const to = clockLabel(dayKey, startMin + durationMin);
  return `${from} – ${to}`;
}

/* ------------------------------------------------------------------ */
/* Events on a day                                                    */
/* ------------------------------------------------------------------ */

/** An event placed on one day's column, ready to be drawn. */
export interface DayEvent {
  event: CalendarEvent;
  /** Minutes from that day's midnight, clamped to the day. */
  startMin: number;
  endMin: number;
  /** True when it began before this day, or runs past the end of it. */
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** Which of the day's overlap columns this block sits in, and how many there are. */
  column: number;
  columns: number;
}

/** True when the event lasts the whole day rather than occupying hours. */
export function isAllDay(event: CalendarEvent): boolean {
  return event.allDay === true;
}

/** The length of a day in minutes, measured rather than assumed. */
export function dayLength(dayKey: string): number {
  const start = fromDateKeyInZone(dayKey);
  const [year, month, day] = parts(dayKey);
  const next = instantFromWallClock({ year, month, day: day + 1 });
  if (Number.isNaN(start.getTime()) || Number.isNaN(next.getTime())) return MINUTES_PER_DAY;
  return Math.round((next.getTime() - start.getTime()) / 60_000);
}

/** One day of the grid, with the entries that touch it already placed. */
export interface DayBucket {
  key: string;
  /** The instant the day begins and the one after it ends, resolved once. */
  start: number;
  end: number;
  /** How long the day is, measured rather than assumed. */
  minutes: number;
  allDay: CalendarEvent[];
  timed: DayEvent[];
}

/**
 * Every day in `days`, with its entries, in one pass.
 *
 * WHY THIS EXISTS
 *
 * Placing an entry on a day is a comparison between two instants, and the days
 * are a contiguous run, so the whole grid can be filled with one walk over the
 * events against the day *boundaries* — resolved once each. The first version
 * of this module asked the question per day and per event instead, and because
 * every boundary in this app comes from `Intl` (see `@/lib/core/zone`), that
 * made a view switch cost O(days x events) zone resolutions. Measured in a
 * browser with 25 entries on screen: **12,488 `formatToParts` calls and 5,504
 * `Date.parse` calls for a single week-to-month switch**, 173ms of script and
 * three long tasks. This function answers the same question with 42 resolutions
 * and one `Date.parse` per end, and the switch is no longer a task anyone can
 * feel.
 *
 * The placement itself is unchanged — same clamp, same `continuesBefore` /
 * `continuesAfter`, same sort, same `packColumns` — and `eventsForDay` and
 * `allDayForDay` are now thin reads of this map, so there is still exactly one
 * implementation of "where does this entry go".
 */
export function bucketDays(
  events: readonly CalendarEvent[],
  days: readonly string[],
): Map<string, DayBucket> {
  const buckets = new Map<string, DayBucket>();
  if (days.length === 0) return buckets;

  const bounds = days.map((key) => {
    const start = fromDateKeyInZone(key).getTime();
    const [year, month, day] = parts(key);
    const end = instantFromWallClock({ year, month, day: day + 1 }).getTime();
    return { key, start, end };
  });

  for (const bound of bounds) {
    buckets.set(bound.key, {
      key: bound.key,
      start: bound.start,
      end: bound.end,
      minutes: Math.round((bound.end - bound.start) / 60_000),
      allDay: [],
      timed: [],
    });
  }

  /** The first day that has not finished by `time`; days are in order. */
  const firstDayAfter = (time: number): number => {
    let low = 0;
    let high = bounds.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((bounds[mid] as { end: number }).end <= time) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  for (const event of events) {
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const allDay = isAllDay(event);

    for (let index = firstDayAfter(start); index < bounds.length; index += 1) {
      const bound = bounds[index] as { key: string; start: number; end: number };
      if (bound.start >= end) break;
      const bucket = buckets.get(bound.key);
      if (!bucket) continue;
      if (allDay) {
        bucket.allDay.push(event);
        continue;
      }
      const rawStart = (start - bound.start) / 60_000;
      const rawEnd = (end - bound.start) / 60_000;
      bucket.timed.push({
        event,
        startMin: clamp(rawStart, 0, bucket.minutes),
        endMin: clamp(rawEnd, 0, bucket.minutes),
        continuesBefore: rawStart < 0,
        continuesAfter: rawEnd > bucket.minutes,
        column: 0,
        columns: 1,
      });
    }
  }

  for (const bucket of buckets.values()) {
    bucket.allDay.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    bucket.timed.sort(
      (a, b) =>
        a.startMin - b.startMin ||
        b.endMin - a.endMin ||
        a.event.title.localeCompare(b.event.title) ||
        a.event.id.localeCompare(b.event.id),
    );
    const packed = packColumns(bucket.timed);
    bucket.timed = bucket.timed.map((entry, index) => ({ ...entry, ...packed[index] }));
  }

  return buckets;
}

/** The all-day entries touching a day, in the order they should be listed. */
export function allDayForDay(events: readonly CalendarEvent[], dayKey: string): CalendarEvent[] {
  return bucketDays(events, [dayKey]).get(dayKey)?.allDay ?? [];
}

/**
 * The timed entries on one day, positioned and packed into columns.
 *
 * The packing is the algorithm every calendar uses and the reason two meetings
 * at 14:00 are each half as wide rather than one hidden behind the other:
 * overlapping entries form clusters, each cluster is as wide as the number of
 * columns its busiest moment needs, and every entry in it takes one column.
 * Clustering is transitive — 9:00–10:00 and 11:00–12:00 with a 10:30–11:30
 * between them are one cluster of two columns, not two clusters of one — which
 * is why this sweeps a running maximum end rather than comparing pairs.
 */
export function eventsForDay(events: readonly CalendarEvent[], dayKey: string): DayEvent[] {
  return bucketDays(events, [dayKey]).get(dayKey)?.timed ?? [];
}

/**
 * Column assignment within overlap clusters.
 *
 * Two passes. The first walks the sorted entries keeping a running maximum end:
 * while the next entry starts before that maximum it belongs to the cluster
 * being built, and when it starts at or after it, the cluster is closed and its
 * width is the number of columns the cluster needed. Every entry in a cluster
 * gets that same width, which is what keeps a day of meetings reading as a grid
 * rather than as a staircase.
 *
 * The column an entry takes is the leftmost one whose last entry has *finished*
 * by the time this one starts — not merely a column no entry has used yet. The
 * difference is the ordinary case of three meetings in a row, 9–10, 9:30–10:30
 * and 10–11: the first and the third do not overlap each other, so they belong
 * in the same column, and a rule that counted usage instead of overlap would
 * draw all three a third of the width wide for no reason at all. That mistake
 * was in the first version of this function and `check-calendar` names it:
 * "a chain of three is one cluster of two columns".
 */
function packColumns<T extends { startMin: number; endMin: number }>(
  entries: readonly T[],
): { column: number; columns: number }[] {
  const out: { column: number; columns: number }[] = entries.map(() => ({ column: 0, columns: 1 }));
  let cluster: number[] = [];
  /** When the last entry in each column finishes, for the cluster being built. */
  let ends: number[] = [];
  let clusterEnd = -Infinity;

  const close = () => {
    const width = Math.max(ends.length, 1);
    for (const index of cluster) {
      const slot = out[index];
      if (slot) slot.columns = width;
    }
    cluster = [];
    ends = [];
  };

  entries.forEach((entry, index) => {
    if (cluster.length > 0 && entry.startMin >= clusterEnd) close();

    let column = ends.findIndex((end) => end <= entry.startMin);
    if (column === -1) {
      column = ends.length;
      ends.push(entry.endMin);
    } else {
      ends[column] = entry.endMin;
    }

    const slot = out[index];
    if (slot) slot.column = column;
    cluster.push(index);
    clusterEnd = Math.max(clusterEnd, entry.endMin);
  });
  if (cluster.length > 0) close();

  return out;
}

/** The height a block is drawn at, in minutes: never shorter than a slot. */
export function blockMinutes(entry: DayEvent): number {
  return Math.max(entry.endMin - entry.startMin, MIN_BLOCK_MINUTES);
}

/* ------------------------------------------------------------------ */
/* How much of a block its resize grips may take                       */
/* ------------------------------------------------------------------ */

/** The tallest a grip is allowed to be, with a mouse and with a finger. */
export const GRIP_MAX_FINE = 8;
export const GRIP_MAX_COARSE = 14;

/**
 * The body a block must keep for the move gesture to have anywhere to start.
 *
 * A finger needs more of it than a mouse does, and the block's height is fixed
 * by its duration, so this is subtracted before the grips get anything.
 */
export const GRIP_BODY_FINE = 12;
export const GRIP_BODY_COARSE = 18;

/** Below this a grip is not a target, so the block is not given one. */
export const GRIP_MIN = 8;

/**
 * How tall each resize grip should be on a block this tall, or `0` for a block
 * that cannot afford one.
 *
 * WHY THIS IS NOT A CONSTANT
 *
 * A block's height *is* its duration, so the two grips compete with the body for
 * the same pixels and the loser is the move gesture. Measured on the phone
 * layout (44px per hour, 14px grips): a 30-minute block is 22px tall and its two
 * grips cover 28px of it. The body was **minus six pixels** — every press on a
 * short entry reached a resize handle, so a very ordinary event could be made
 * longer but never moved. With a mouse at 56px per hour the same block is 28px
 * and the body is 12px, so this was worst under a thumb and present everywhere.
 *
 * The rule is therefore: take the grip out of what is left after the body, cap
 * it, and if the result is too thin to hit, hand the whole block back to the
 * move gesture. Resizing a fifteen-minute entry is what the editor's `minutes`
 * field is for, and that is exact.
 */
export function gripHeightFor(blockHeight: number, coarse: boolean): number {
  const cap = coarse ? GRIP_MAX_COARSE : GRIP_MAX_FINE;
  const body = coarse ? GRIP_BODY_COARSE : GRIP_BODY_FINE;
  const each = (blockHeight - body) / 2;
  if (each < GRIP_MIN) return 0;
  return Math.min(cap, Math.floor(each));
}

/* ------------------------------------------------------------------ */
/* Pointer -> what it means                                           */
/* ------------------------------------------------------------------ */

/** A day column's horizontal extent, in the grid's own pixel space. */
export interface ColumnBox {
  key: string;
  left: number;
  width: number;
}

/**
 * Which column a horizontal position is over.
 *
 * Nearest rather than contained, because a drag that leaves the grid sideways
 * should still mean the first or last day rather than nothing at all — letting
 * go just past the edge is a near miss, and cancelling it would be the
 * interface being pedantic about a pixel.
 */
export function columnAt(x: number, columns: readonly ColumnBox[]): string | null {
  if (columns.length === 0) return null;
  const first = columns[0];
  const last = columns[columns.length - 1];
  if (!first || !last) return null;
  if (x <= first.left) return first.key;
  if (x >= last.left + last.width) return last.key;
  for (const column of columns) {
    if (x >= column.left && x < column.left + column.width) return column.key;
  }
  return last.key;
}

/** Minutes from the top of the day for a vertical position in the scroller. */
export function minutesAt(
  y: number,
  gridTop: number,
  scrollTop: number,
  hourHeight: number,
): number {
  return ((y - gridTop + scrollTop) / hourHeight) * 60;
}

/**
 * Where a dragged block should land.
 *
 * `grab` is how far into the block the pointer took hold. A drag that ignored it
 * would jump the block so its top edge met the pointer the moment you moved,
 * which reads as the calendar yanking the thing out of your hand. The result is
 * snapped, then held inside the day, so a block dragged off the bottom stops at
 * the bottom rather than vanishing into tomorrow.
 */
export function dropMinutes(
  pointerMinutes: number,
  grab: number,
  duration: number,
  dayMinutes: number = MINUTES_PER_DAY,
  slot: number = SLOT_MINUTES,
): number {
  const wanted = snap(pointerMinutes - grab, slot);
  return clamp(wanted, 0, Math.max(0, dayMinutes - Math.min(duration, dayMinutes)));
}

/** The patch that moves an event to a day and a minute. */
export function movePatch(
  event: CalendarEvent,
  dayKey: string,
  startMin: number,
): { date: string; time?: string; minutes?: number } {
  // An all-day entry has no clock to move: sending one would turn a day into a
  // moment, which is exactly the edit nobody asked for.
  if (isAllDay(event)) return { date: dayKey };
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const duration = Number.isNaN(start) || Number.isNaN(end) ? DEFAULT_MINUTES : Math.max(
    Math.round((end - start) / 60_000),
    MIN_BLOCK_MINUTES,
  );
  return { date: dayKey, time: formatClock(startMin), minutes: duration };
}

/** The patch that resizes an event to a new start and length. */
export function resizePatch(
  event: CalendarEvent,
  dayKey: string,
  startMin: number,
  durationMin: number,
): { date: string; time?: string; minutes?: number } {
  if (isAllDay(event)) return { date: dayKey };
  return {
    date: dayKey,
    time: formatClock(startMin),
    minutes: clamp(Math.round(durationMin), MIN_BLOCK_MINUTES, MAX_MINUTES),
  };
}

/** The duration an event is drawn with, in minutes. */
export function durationOf(event: CalendarEvent): number {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return DEFAULT_MINUTES;
  return Math.max(Math.round((end - start) / 60_000), MIN_BLOCK_MINUTES);
}

/**
 * The record as it will look if the server accepts the move.
 *
 * A drop has to be visible on the next frame, not one round trip later, so the
 * calendar writes the record it expects and reconciles when the answer arrives.
 * This is the *only* place the optimistic shape is built, so the thing drawn
 * during a drop and the thing the server stores cannot drift apart by an hour —
 * both go through `instantFor`, which is the app's clock.
 */
export function optimisticMove(event: CalendarEvent, dayKey: string, startMin: number): CalendarEvent {
  if (isAllDay(event)) {
    const start = instantFor(dayKey, 0);
    const next = instantFor(addDays(dayKey, 1), 0);
    return { ...event, start: start.toISOString(), end: next.toISOString() };
  }
  const start = instantFor(dayKey, startMin);
  const end = new Date(start.getTime() + durationOf(event) * 60_000);
  return { ...event, start: start.toISOString(), end: end.toISOString() };
}

/** The record as it will look if the server accepts the resize. */
export function optimisticResize(
  event: CalendarEvent,
  dayKey: string,
  startMin: number,
  minutes: number,
): CalendarEvent {
  const start = instantFor(dayKey, startMin);
  const end = new Date(start.getTime() + minutes * 60_000);
  return { ...event, start: start.toISOString(), end: end.toISOString() };
}

/** A record the calendar has just asked for, before the server has answered. */
export function optimisticCreate(
  id: string,
  title: string,
  dayKey: string,
  startMin: number,
  minutes: number,
  location?: string,
): CalendarEvent {
  const start = instantFor(dayKey, startMin);
  const end = new Date(start.getTime() + minutes * 60_000);
  return {
    id,
    title,
    start: start.toISOString(),
    end: end.toISOString(),
    location,
    source: "user",
    xanaAuthored: false,
    allDay: false,
  };
}

/**
 * The first free slot on a day at or after `from`, so a click on a busy hour
 * does not stack a new entry on top of an existing one.
 */
export function nextFreeStart(
  events: readonly CalendarEvent[],
  dayKey: string,
  from: number,
  duration: number = DEFAULT_MINUTES,
): number {
  const taken = eventsForDay(events, dayKey).sort((a, b) => a.startMin - b.startMin);
  let candidate = clamp(from, 0, MINUTES_PER_DAY - duration);
  for (const entry of taken) {
    if (entry.endMin <= candidate) continue;
    if (entry.startMin >= candidate + duration) break;
    candidate = snap(entry.endMin);
  }
  return clamp(candidate, 0, Math.max(0, MINUTES_PER_DAY - duration));
}
