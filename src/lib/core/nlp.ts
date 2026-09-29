/**
 * Natural-language time parsing.
 *
 * "Friday", "tomorrow at 3", "in 20 minutes", "next Tuesday morning", "the 14th".
 * This is the difference between Xana being an assistant and being a text box,
 * so it is hand-written and deterministic rather than model-dependent: it works
 * offline, it never hallucinates a date, and it returns `undefined` instead of
 * guessing when it is not sure.
 *
 * Every result carries the `matched` span so the caller can strip the time
 * expression out of the task title ("call Mom Friday" -> "call Mom").
 */

import { addDays, addMinutes, startOfDay, toDateKey } from "./time";

export interface ParsedTime {
  date: Date;
  /** The exact substring that expressed the time. */
  matched: string;
  /** True when a clock time was given, not just a day. */
  hasTime: boolean;
  /** 0..1 — how confident the parse is. */
  confidence: number;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/** Named times of day, as start hours. */
const PART_OF_DAY: Record<string, number> = {
  morning: 9,
  noon: 12,
  midday: 12,
  afternoon: 14,
  evening: 18,
  tonight: 20,
  night: 20,
};

/**
 * Resolve a weekday reference.
 *
 * "Friday" and "next Friday" both mean the coming Friday — the nearest future
 * occurrence. English "next <weekday>" is genuinely ambiguous, but nobody means
 * "skip a week" when they say it, and a reminder set 12 days out when the user
 * meant 5 is a real failure. A weekday that is *today* always rolls forward a
 * week, since you cannot mean the day you are already in.
 */
function nextWeekday(from: Date, target: number): Date {
  const d = startOfDay(from);
  let delta = (target - d.getDay() + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(d, delta);
}

/**
 * Parse a time expression. `now` is injectable so tests and the seed script can
 * be deterministic.
 */
export function parseWhen(input: string, now: Date = new Date()): ParsedTime | undefined {
  const text = input.toLowerCase();
  const candidates: ParsedTime[] = [];

  /*
   * Unambiguous forms return immediately.
   *
   * This matters because the clock matcher below is broad: given "in 2 hours"
   * it happily finds "2" and, since a clock time would outrank a day, would
   * turn a two-hour duration into 2am. Any expression that states its own
   * meaning resolves before the looser patterns get a look at it.
   */

  /* --- Relative: "in 20 minutes", "in 2 hours", "in 3 days" --- */
  const rel = /\bin\s+(\d{1,3})\s*(minutes?|mins?|hours?|hrs?|h|days?|weeks?)\b/.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    let date: Date;
    if (/^min/.test(unit)) date = addMinutes(now, n);
    else if (/^h/.test(unit)) date = addMinutes(now, n * 60);
    else if (/^day/.test(unit)) date = addDays(now, n);
    else date = addDays(now, n * 7);
    return { date, matched: rel[0], hasTime: /^min|^h/.test(unit), confidence: 0.95 };
  }

  /* --- "N <unit> from now" --- */
  const fromNow = /\b(\d{1,3})\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\s+from now\b/.exec(text);
  if (fromNow) {
    const n = Number(fromNow[1]);
    const unit = fromNow[2];
    const date = /^min/.test(unit)
      ? addMinutes(now, n)
      : /^h/.test(unit)
        ? addMinutes(now, n * 60)
        : /^day/.test(unit)
          ? addDays(now, n)
          : addDays(now, n * 7);
    return { date, matched: fromNow[0], hasTime: /^min|^h/.test(unit), confidence: 0.95 };
  }

  /* --- Absolute dates state themselves fully; nothing may override them. --- */
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) {
    return {
      date: new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])),
      matched: iso[0],
      hasTime: false,
      confidence: 0.98,
    };
  }

  const monthDay = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (monthDay) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = months.indexOf(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month >= 0 && day >= 1 && day <= 31) {
      const candidate = new Date(now.getFullYear(), month, day);
      // A date already past this year means next year.
      if (candidate < startOfDay(now)) candidate.setFullYear(now.getFullYear() + 1);
      return { date: candidate, matched: monthDay[0], hasTime: false, confidence: 0.92 };
    }
  }

  /* --- "tomorrow", "today", "tonight", "day after tomorrow" --- */
  const dayWords: Array<[RegExp, number]> = [
    [/\bday after tomorrow\b/, 2],
    [/\btomorrow\b|\btmrw\b|\btmr\b/, 1],
    [/\btoday\b|\btonight\b/, 0],
    [/\byesterday\b/, -1],
  ];
  for (const [re, offset] of dayWords) {
    const m = re.exec(text);
    if (m) {
      candidates.push({
        date: addDays(startOfDay(now), offset),
        matched: m[0],
        hasTime: false,
        confidence: 0.9,
      });
      break;
    }
  }

  /* --- Weekday names, optionally "next" --- */
  const weekdayRe = /\b(next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thur|thurs|thu|friday|fri|saturday|sat)\b/;
  const wd = weekdayRe.exec(text);
  if (wd) {
    const target = WEEKDAYS[wd[2]];
    if (target !== undefined) {
      candidates.push({
        date: nextWeekday(now, target),
        matched: wd[0],
        hasTime: false,
        confidence: 0.88,
      });
    }
  }

  /* --- "on the 14th" --- */
  const ordinal = /\bon the (\d{1,2})(?:st|nd|rd|th)\b/.exec(text);
  if (ordinal) {
    const day = Number(ordinal[1]);
    if (day >= 1 && day <= 31) {
      let date = new Date(now.getFullYear(), now.getMonth(), day);
      if (date < startOfDay(now)) date = new Date(now.getFullYear(), now.getMonth() + 1, day);
      candidates.push({ date, matched: ordinal[0], hasTime: false, confidence: 0.8 });
    }
  }

  /*
   * --- Clock times: "at 3pm", "15:30", "at 9" ---
   *
   * A bare numeral only counts as an hour when something marks it as one: an
   * explicit meridiem, a colon, a preceding "at", or a value that cannot be
   * anything else (13-23). Without those guards "review 5 PRs" schedules a
   * meeting.
   */
  const clock = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/.exec(
    text.replace(/\b(\d{1,2})\s*(am|pm)\b/g, "$1$2"),
  );
  let clockHour: number | undefined;
  let clockMinute = 0;
  let clockMatched = "";
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const meridiem = clock[3]?.replace(/\./g, "");
    const hasMeridiem = Boolean(meridiem);
    const isColonTime = Boolean(clock[2]);
    const precededByAt = /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/.test(text);
    const unambiguousHour = hour >= 13 && hour <= 23;

    const plausible = hasMeridiem || isColonTime || precededByAt || unambiguousHour;
    if (plausible && hour <= 24) {
      if (meridiem?.startsWith("p") && hour < 12) hour += 12;
      if (meridiem?.startsWith("a") && hour === 12) hour = 0;
      // Bare hour 1-6, but marked as a time: almost certainly afternoon.
      if (!hasMeridiem && !isColonTime && hour >= 1 && hour <= 6) hour += 12;
      clockHour = hour % 24;
      clockMinute = minute;
      clockMatched = clock[0].trim();
    }
  }

  /* --- Named parts of day: "in the morning", "tomorrow evening" --- */
  let partHour: number | undefined;
  let partMatched = "";
  for (const [word, hour] of Object.entries(PART_OF_DAY)) {
    const re = new RegExp(`\\b${word}\\b`);
    const m = re.exec(text);
    if (m) {
      partHour = hour;
      partMatched = m[0];
      break;
    }
  }

  /* --- Combine the best day candidate with the best time candidate. --- */
  const dayCandidate = candidates
    .filter((c) => !c.hasTime)
    .sort((a, b) => b.confidence - a.confidence)[0];

  const base = dayCandidate ? new Date(dayCandidate.date) : startOfDay(now);

  if (clockHour !== undefined) {
    const withTime = new Date(base);
    withTime.setHours(clockHour, clockMinute, 0, 0);
    // A bare time already past means the next occurrence, not the past.
    if (!dayCandidate && withTime <= now) withTime.setDate(withTime.getDate() + 1);
    return {
      date: withTime,
      matched: [dayCandidate?.matched, clockMatched].filter(Boolean).join(" ").trim(),
      hasTime: true,
      confidence: dayCandidate ? 0.95 : 0.8,
    };
  }

  if (partHour !== undefined) {
    const withTime = new Date(base);
    withTime.setHours(partHour, 0, 0, 0);
    if (!dayCandidate && withTime <= now) withTime.setDate(withTime.getDate() + 1);
    return {
      date: withTime,
      matched: [dayCandidate?.matched, partMatched].filter(Boolean).join(" ").trim(),
      hasTime: true,
      confidence: dayCandidate ? 0.85 : 0.72,
    };
  }

  if (dayCandidate) {
    return { ...dayCandidate };
  }

  return undefined;
}

/**
 * A duration in minutes: "for 90 minutes", "for 2 hours".
 * Used by focus sessions and task estimates.
 */
export function parseDuration(input: string): number | undefined {
  const m = /\b(?:for\s+)?(\d{1,3})\s*(min|mins|minutes?|h|hr|hrs|hours?)\b/i.exec(input);
  if (!m) {
    if (/\bhalf an hour\b/i.test(input)) return 30;
    if (/\ban hour\b/i.test(input)) return 60;
    return undefined;
  }
  const n = Number(m[1]);
  return /^min/i.test(m[2]) ? n : n * 60;
}

/** Remove a parsed time span from a phrase, tidying the leftovers. */
export function stripWhen(text: string, matched: string): string {
  if (!matched) return text.trim();
  let out = text;
  for (const piece of matched.split(/\s+/).filter(Boolean)) {
    // Only strip whole words, and only the first occurrence.
    out = out.replace(new RegExp(`\\b${escapeRegExp(piece)}\\b`, "i"), " ");
  }
  return out
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/^[\s,.\-–—]+|[\s,.\-–—]+$/g, "")
    .replace(/\b(at|on|by|for|due)\s*$/i, "")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Local calendar day key for a parsed time, for display. */
export function dayKeyOf(date: Date): string {
  return toDateKey(date);
}
