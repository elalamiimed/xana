/**
 * The app's own clock.
 *
 * WHY THIS EXISTS
 *
 * Xana's day is Asia/Shanghai's day, not the machine's and not the browser's.
 * The server formats an instant with the operating system's zone and the browser
 * formats the same instant with its own, so any two zones that straddle midnight
 * disagree about which day it is for eight hours a day: a task due "tomorrow"
 * can render as "today" in one half of the app and "tomorrow" in the other. One
 * zone, named once, removes the disagreement. The user asked for it in as many
 * words, "use beijing time in calendar".
 *
 * WHY IT IS A SEPARATE MODULE
 *
 * `core/time.ts` is server side: it imports `node:crypto` for id generation, so
 * a client component that wants a formatter cannot import it. That is why
 * `CardView.tsx` used to carry its own copy of the same three formatters, and
 * why a client-side label could drift from the server's answer. This file has no
 * imports at all, so both halves of the app can use the same helpers.
 *
 * NO FIXED OFFSET
 *
 * "+08:00" is not written anywhere in this file. Every helper asks `Intl` for
 * the zone's wall-clock fields, and the zone is a parameter with `APP_TIME_ZONE`
 * as its default, so the constant can move to a zone with a different offset, or
 * with daylight saving, without rewriting the arithmetic. Asia/Shanghai has no
 * DST, which is why a day here is exactly 24 hours; the two-pass offset
 * resolution in `instantFromWallClock` is what keeps that from being assumed.
 *
 * WHAT IS NOT PINNED
 *
 * The zone is pinned; the language is not. `clockInZone` and the weekday labels
 * use the runtime's own locale, exactly as the `toLocale*` calls they replace
 * did, so an English machine still reads "01:30 AM" and "Saturday" rather than
 * switching to a 24 hour clock or another language's names.
 */

export const APP_TIME_ZONE = "Asia/Shanghai";

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * Formatters are built once per zone and option set.
 *
 * Constructing one is the expensive part of `Intl`, and these helpers are called
 * for every row of every list, so a fresh formatter per call would be felt.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zone}|${JSON.stringify(options)}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat(undefined, { ...options, timeZone: zone });
  formatters.set(key, made);
  return made;
}

interface ZoneFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * The wall-clock fields of an instant in `zone`, or undefined when the instant
 * is not a real one.
 *
 * The `undefined` return is load-bearing rather than defensive. `Intl` throws a
 * `RangeError` on an invalid date where `toLocale*` used to return the string
 * "Invalid Date", and every caller of these helpers is a label on a panel. A
 * cave room renders `dayFullLabel("")` on its first frame, before the server has
 * said which day it is, so the difference between the two is the difference
 * between a blank label and the render throwing: `toLocale*` hid bad input, and
 * `Intl` announces it.
 *
 * `hourCycle: "h23"` rather than `hour12: false`: the latter is documented to
 * resolve to either h23 or h24 depending on the locale, and h24 renders midnight
 * as "24" with hour "2-digit". Everything downstream of this assumes a 0 to 23
 * hour, so the cycle is named rather than left to the locale.
 */
function fieldsInZone(instant: Date, zone: string): ZoneFields | undefined {
  if (Number.isNaN(instant.getTime())) return undefined;
  const found = new Map<string, string>();
  const parts = formatter(zone, {
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  for (const part of parts) {
    if (part.type !== "literal") found.set(part.type, part.value);
  }
  const at = (type: string): number => Number(found.get(type) ?? "0");
  return {
    year: at("year"),
    month: at("month"),
    day: at("day"),
    hour: at("hour"),
    minute: at("minute"),
    second: at("second"),
  };
}

/**
 * A locale-shaped label for an instant, or "" when the instant is not real.
 *
 * Empty rather than an en dash, because these labels are also `aria-label` and
 * `title` text: a dash would be read aloud as punctuation, and nothing is the
 * honest description of a value that is not a date.
 */
function labelInZone(instant: Date, zone: string, options: Intl.DateTimeFormatOptions): string {
  if (Number.isNaN(instant.getTime())) return "";
  return formatter(zone, options).format(instant);
}

/** The zone's offset from UTC at an instant, measured rather than assumed. */
function zoneOffsetMs(instant: Date, zone: string): number {
  const fields = fieldsInZone(instant, zone);
  if (!fields) return NaN;
  const asUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  // The fields carry no milliseconds, so the instant is compared at the
  // resolution the fields can express.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** A wall-clock reading in a zone, with the date required and the rest optional. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

/**
 * A wall-clock reading in `zone` as an absolute instant.
 *
 * Two passes, because the offset depends on the instant and the instant depends
 * on the offset: the first measures the offset at the naive reading, the second
 * re-measures it at the candidate instant. One pass is an hour wrong across a
 * daylight-saving edge, and a zone like Asia/Shanghai would never reveal it.
 */
export function instantFromWallClock(wall: WallClock, zone: string = APP_TIME_ZONE): Date {
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour ?? 0,
    wall.minute ?? 0,
    wall.second ?? 0,
    wall.millisecond ?? 0,
  );
  const first = new Date(naive - zoneOffsetMs(new Date(naive), zone));
  return new Date(naive - zoneOffsetMs(first, zone));
}

/** The app's calendar date as YYYY-MM-DD, in `zone`, or "" if there is no date. */
export function dateKeyInZone(instant: Date = new Date(), zone: string = APP_TIME_ZONE): string {
  const fields = fieldsInZone(instant, zone);
  if (!fields) return "";
  return `${fields.year}-${pad(fields.month)}-${pad(fields.day)}`;
}

/** A clock reading the way a person reads it, in the runtime's own locale. */
export function clockInZone(instant: Date = new Date(), zone: string = APP_TIME_ZONE): string {
  return labelInZone(instant, zone, { hour: "2-digit", minute: "2-digit" });
}

/**
 * "HH:mm", 24 hour, zero padded.
 *
 * The form a `<input type="time">` value needs and the form two readings can be
 * compared in. Separate from `clockInZone` because a control's value is not a
 * label: it must not follow the locale's hour cycle.
 */
export function hourMinuteInZone(instant: Date = new Date(), zone: string = APP_TIME_ZONE): string {
  const fields = fieldsInZone(instant, zone);
  if (!fields) return "";
  return `${pad(fields.hour)}:${pad(fields.minute)}`;
}

/** The hour of the day, 0 to 23, in `zone`; NaN when there is no instant. */
export function hourInZone(instant: Date = new Date(), zone: string = APP_TIME_ZONE): number {
  return fieldsInZone(instant, zone)?.hour ?? NaN;
}

/** The minute of the hour, 0 to 59, in `zone`; NaN when there is no instant. */
export function minuteInZone(instant: Date = new Date(), zone: string = APP_TIME_ZONE): number {
  return fieldsInZone(instant, zone)?.minute ?? NaN;
}

/** The instant `zone`'s day begins for the day `instant` falls in. */
export function startOfDayInZone(instant: Date = new Date(), zone: string = APP_TIME_ZONE): Date {
  const fields = fieldsInZone(instant, zone);
  // An unusable instant gives an unusable day, which propagates to every caller
  // as an ordinary invalid `Date` rather than as a throw.
  if (!fields) return new Date(NaN);
  return instantFromWallClock({ year: fields.year, month: fields.month, day: fields.day }, zone);
}

/**
 * The last millisecond of the day `instant` falls in.
 *
 * Derived from the next day's start rather than by writing 23:59:59.999, so a
 * zone whose day does not end at a round hour still ends where the next one
 * begins.
 */
export function endOfDayInZone(instant: Date = new Date(), zone: string = APP_TIME_ZONE): Date {
  return new Date(startOfDayInZone(addDaysInZone(instant, 1, zone), zone).getTime() - 1);
}

/** `instant` moved by whole calendar days, keeping its wall-clock time. */
export function addDaysInZone(
  instant: Date,
  days: number,
  zone: string = APP_TIME_ZONE,
): Date {
  const fields = fieldsInZone(instant, zone);
  if (!fields) return new Date(NaN);
  // An out-of-range day is normalised by Date.UTC, so month and year roll over.
  return instantFromWallClock(
    {
      year: fields.year,
      month: fields.month,
      day: fields.day + days,
      hour: fields.hour,
      minute: fields.minute,
      second: fields.second,
      millisecond: instant.getMilliseconds(),
    },
    zone,
  );
}

/** `instant` moved by whole calendar months, keeping its wall-clock time. */
export function addMonthsInZone(
  instant: Date,
  months: number,
  zone: string = APP_TIME_ZONE,
): Date {
  const fields = fieldsInZone(instant, zone);
  if (!fields) return new Date(NaN);
  return instantFromWallClock(
    {
      year: fields.year,
      month: fields.month + months,
      day: fields.day,
      hour: fields.hour,
      minute: fields.minute,
      second: fields.second,
      millisecond: instant.getMilliseconds(),
    },
    zone,
  );
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A date key as a count of days since the epoch, or NaN when the key is not a
 * date.
 *
 * Counted in UTC, but only ever used to subtract one calendar date from another,
 * so the zone drops out: this is what makes "days between" independent of how
 * many hours a particular day happened to contain.
 */
function dayNumber(key: string): number {
  if (!DATE_KEY.test(key)) return NaN;
  const [year, month, day] = key.split("-").map(Number);
  return Math.floor(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / 86_400_000);
}

/**
 * Whole calendar days from `a` to `b` in `zone`; negative when `b` is earlier,
 * and NaN when either instant is not a real date.
 */
export function daysBetweenInZone(a: Date, b: Date, zone: string = APP_TIME_ZONE): number {
  return dayNumber(dateKeyInZone(b, zone)) - dayNumber(dateKeyInZone(a, zone));
}

/**
 * The instant a date key begins in `zone`.
 *
 * A key that is not a date gives an invalid `Date` rather than throwing: these
 * keys arrive from the database and the wire, and a formatter that throws takes
 * the whole panel down over one bad row.
 */
export function fromDateKeyInZone(key: string, zone: string = APP_TIME_ZONE): Date {
  const match = DATE_KEY.exec(key.trim());
  if (!match) return new Date(NaN);
  return instantFromWallClock(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
    zone,
  );
}

/** Monday is 0 and Sunday is 6, read from the zone's calendar date. */
export function weekdayIndexInZone(
  instant: Date = new Date(),
  zone: string = APP_TIME_ZONE,
): number {
  const key = dateKeyInZone(instant, zone);
  if (!DATE_KEY.test(key)) return NaN;
  const [year, month, day] = key.split("-").map(Number);
  // The weekday of a calendar date is the same in every zone, so the epoch value
  // of that date is the honest way to ask for it.
  const utcDay = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay();
  return (utcDay + 6) % 7;
}

/** "Saturday", in the runtime's locale, for the zone's calendar date. */
export function weekdayLongInZone(instant: Date, zone: string = APP_TIME_ZONE): string {
  return labelInZone(instant, zone, { weekday: "long" });
}

/** "Sat", in the runtime's locale, for the zone's calendar date. */
export function weekdayShortInZone(instant: Date, zone: string = APP_TIME_ZONE): string {
  return labelInZone(instant, zone, { weekday: "short" });
}

/** "Oct 3", in the runtime's locale, for the zone's calendar date. */
export function monthDayInZone(instant: Date, zone: string = APP_TIME_ZONE): string {
  return labelInZone(instant, zone, { month: "short", day: "numeric" });
}

/** "Saturday, Oct 3", the whole of a day in one line. */
export function weekdayMonthDayInZone(instant: Date, zone: string = APP_TIME_ZONE): string {
  return labelInZone(instant, zone, { weekday: "long", month: "short", day: "numeric" });
}

/**
 * A day said the way a person would say it: today, tomorrow, yesterday, the
 * weekday when it is close, and the date when it is not.
 *
 * `now` is a parameter rather than read from the clock so the label is a
 * function of two instants and can be asserted at a day boundary.
 */
export function dayLabelInZone(
  instant: Date,
  now: Date = new Date(),
  zone: string = APP_TIME_ZONE,
): string {
  const days = daysBetweenInZone(now, instant, zone);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1 && days < 7) return weekdayLongInZone(instant, zone);
  return monthDayInZone(instant, zone);
}
