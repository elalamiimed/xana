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
  /**
   * The clock an *end* was stated for, when the phrase gave a range.
   *
   * "10:00 to 10:30" names two o'clock times and the second one is the end, not
   * a second start. Before this existed the end was thrown away and every entry
   * got the caller's default length, so "gym from 10 to 10:30" was stored as an
   * hour. `end` is resolved against the same day as `date`, and only set when
   * the phrase really stated a range.
   */
  end?: Date;
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

  /**
   * A stated range, matched *before* the single clock so its end is available.
   *
   * Three shapes people write:
   *
   *   "10:00 to 10:30"   two colon times around a separator
   *   "10 to 10:30"      a bare hour on the left, which "10-10:30" also is
   *   "10:30 to 11:30 am" the meridiem trailing the whole range
   *
   * The bare-hour form needs its own pattern: `10-10:30` is not read as a clock
   * at all by the rules below, because a bare numeral counts as an hour only
   * when something marks it as one. Inside a range, the separator is that mark —
   * "from 10-10:30" is a time, where "review 10-10:30" was never going to be
   * anything else either.
   *
   * The end is only taken when it is *after* the start within a plausible
   * morning/afternoon window; "11:30 to 12:30" keeps its meridiem, and a range
   * that runs backwards ("10 to 9") is left alone rather than wrapped.
   */
  const range =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(text) ??
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\b/.exec(text) ??
    /\b(\d{1,2})(?::(\d{2}))?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(text) ??
    /\b(\d{1,2}):(\d{2})\s*(?:-|–|—|to|until|till)\s*(\d{1,2}):(\d{2})\b/.exec(text) ??
    /\b(\d{1,2})\s*(?:-|–|—|to|until|till)\s*(\d{1,2}):(\d{2})\b/.exec(text);

  /**
   * Minutes past midnight for an hour/minute pair, honouring a meridiem.
   *
   * A half of a range with no meridiem of its own borrows the other half's —
   * which is why the caller passes one meridiem for both ends. With none at all
   * ("10-10:30"), an hour in the 1..7 band is read as the afternoon, because a
   * range written without am/pm is a working-day range, and nobody means 3am.
   */
  const asMinutes = (hour: number, minute: number, meridiem?: string): number | undefined => {
    let h = hour;
    const mer = meridiem?.replace(/\./g, "");
    if (mer?.startsWith("p") && h < 12) h += 12;
    if (mer?.startsWith("a") && h === 12) h = 0;
    if (!mer && h >= 1 && h <= 7) h += 12;
    if (h > 24 || minute > 59) return undefined;
    return (h % 24) * 60 + minute;
  };

  /**
   * Split a range match into its two clock times.
   *
   * Reading groups by shape rather than by position is the whole job here, and
   * getting it wrong is silent. `"9am to 10am"` yields **six** groups —
   * `["9", undefined, "am", "10", undefined, "am"]` — and the first version of
   * this filtered the undefineds out and mapped the rest to numbers, giving
   * `[9, 10, 10]`: the second meridiem became the *minute* of the end time, the
   * end landed before the start, and the whole range was discarded while every
   * regex in the chain above had matched correctly. The groups are therefore
   * read in place, with the optional minute kept optional.
   *
   * The patterns put the two clocks in a fixed order — hour, minute?, meridiem?
   * twice — so the shape is known even though the group count varies.
   */
  const readRange = (match: RegExpExecArray | null): { start: number; end: number } | undefined => {
    if (!match) return undefined;
    const parts = match.slice(1);

    /** The first clock in `parts`, as `{ hour, minute, meridiem }`. */
    const clockAt = (offset: number, kind: "start" | "end") => {
      if (offset >= parts.length) return undefined;
      const hour = /^\d+$/.test(parts[offset] ?? "") ? Number(parts[offset]) : undefined;
      if (hour === undefined) return undefined;
      const minute = /^\d+$/.test(parts[offset + 1] ?? "") ? Number(parts[offset + 1]) : 0;
      const meridiem = /^(am|pm)$/.test(parts[offset + 2] ?? "") ? parts[offset + 2] : undefined;
      void kind;
      return { hour, minute, meridiem };
    };

    /*
     * Which of the patterns matched decides where the second clock starts.
     *
     * The five patterns have group counts of 6, 5, 5, 4 and 3, and only the
     * first two carry a meridiem *before* the separator. Rather than guess, the
     * index of the separator is found: everything before it is the first clock,
     * everything after is the second.
     */
    const flat = match[0].toLowerCase();
    const separator = /(?:-|–|—|\bto\b|\buntil\b|\btill\b)/i.exec(flat);
    const head = separator ? flat.slice(0, separator.index) : flat;
    const tail = separator ? flat.slice(separator.index + separator[0].length) : "";

    const read = (chunk: string) => {
      const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(chunk);
      if (!m) return undefined;
      return { hour: Number(m[1]), minute: m[2] ? Number(m[2]) : 0, meridiem: m[3] };
    };

    const from = read(head);
    const to = read(tail);
    if (!from || !to) return undefined;

    // A meridiem written on either half applies to both: "9am to 10" and
    // "10 to 11:30 am" both mean a morning, not a morning and an evening.
    const meridiem = from.meridiem ?? to.meridiem;
    const start = asMinutes(from.hour, from.minute, from.meridiem ?? meridiem);
    const end = asMinutes(to.hour, to.minute, to.meridiem ?? meridiem);
    if (start === undefined || end === undefined || end <= start) return undefined;
    return { start, end };
  };

  let rangeEndMinutes: number | undefined;
  let rangeStartMinutes: number | undefined;
  let rangeMatched = "";
  const parsedRange = readRange(range);
  if (parsedRange) {
    rangeStartMinutes = parsedRange.start;
    rangeEndMinutes = parsedRange.end;
    rangeMatched = range![0].trim();
  }

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

    /*
     * A stated range ends when it said it ends.
     *
     * The end is built on `withTime`'s own day so the two cannot straddle
     * midnight by accident, and it is dropped rather than wrapped if it lands
     * before the start — a range that reads backwards is a parse failure worth
     * ignoring, not a booking that runs past midnight.
     */
    let end: Date | undefined;
    if (rangeEndMinutes !== undefined) {
      const candidate = new Date(withTime);
      candidate.setHours(Math.floor(rangeEndMinutes / 60), rangeEndMinutes % 60, 0, 0);
      if (candidate > withTime) end = candidate;
    }

    /*
     * `matched` is what `stripWhen` removes to leave a title, so it has to hold
     * every piece of text that expressed the *time* — the day, the clock, and
     * the rest of a range.
     *
     * The clock match alone stops after the first time ("10:00"), which left
     * "to 10:30" in the title: "breakfast tomorrow 10:00 to 10:30" became
     * "breakfast to 10:30". The range's own text is included when there is one,
     * because it is unambiguously part of the time and removing it cannot touch
     * a word of the title.
     */
    const matchedParts = [dayCandidate?.matched, clockMatched, rangeMatched].filter(Boolean);

    return {
      date: withTime,
      matched: [...new Set(matchedParts)].join(" ").trim(),
      hasTime: true,
      confidence: dayCandidate ? 0.95 : 0.8,
      ...(end ? { end } : {}),
    };
  }

  /*
   * A range with no single clock at its head: "from 10-10:30".
   *
   * The range match above already knows the start; it is only `clockHour` that
   * never fired, because a bare numeral needs a mark to be read as an hour and
   * the range's own separator is that mark. Without this branch the phrase fell
   * through to day-only and the whole clock was lost — which is what happened to
   * "add tomorrow breakfast from 10-10:30".
   */
  if (rangeEndMinutes !== undefined && rangeStartMinutes !== undefined && !clockMatched) {
    const start = new Date(base);
    start.setHours(Math.floor(rangeStartMinutes / 60), rangeStartMinutes % 60, 0, 0);
    if (!dayCandidate && start <= now) start.setDate(start.getDate() + 1);
    const end = new Date(start);
    end.setHours(Math.floor(rangeEndMinutes / 60), rangeEndMinutes % 60, 0, 0);
    if (end > start) {
      return {
        date: start,
        matched: [dayCandidate?.matched, rangeMatched].filter(Boolean).join(" ").trim(),
        hasTime: true,
        confidence: dayCandidate ? 0.9 : 0.78,
        end,
      };
    }
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

/**
 * Remove a parsed time span from a phrase, tidying the leftovers.
 *
 * Two things had to change for the ranges people actually type.
 *
 * The first is the order. The span used to be stripped word by word, each word
 * removed wherever it appeared — so a range like "10:00 to 10:30" removed the
 * "to" from *anywhere* in the sentence, and "add breakfast to my calendar from
 * 10-10:30" came out as "add breakfast my calendar from". The span is a
 * contiguous thing the parser matched, so it is removed as one piece first, and
 * the word-wise pass is left to collect the pieces that genuinely are scattered
 * (a day and a clock time separated by other words).
 *
 * The second is the separators ranges leave behind: "from", and a dangling
 * en dash or "-". "gym from 10:30 to 11:30 am" should read "gym", and
 * "lunch 12:00-13:00" should read "lunch".
 */
export function stripWhen(text: string, matched: string): string {
  if (!matched) return text.trim();

  let out = text;

  /*
   * The longest pieces first.
   *
   * `matched` is a set of spans, not one string: a day and a clock are usually
   * separated by the title ("breakfast tomorrow 10:00 to 10:30"), so they are
   * removed individually. Removing "10:00 to 10:30" before "10:00" matters —
   * otherwise the shorter piece leaves "to 10:30" behind, which is how a title
   * came out as "breakfast to".
   */
  const pieces = [...new Set([matched, ...matched.split(/\s+/)])]
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .sort((a, b) => b.length - a.length);

  for (const piece of pieces) {
    out = out.replace(new RegExp(escapeRegExp(piece), "i"), " ");
  }

  return out
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    /*
     * The seam a range leaves behind.
     *
     * Once the times are gone, what is left is the connective tissue: "from",
     * a dangling "to", or a bare dash. They are only removed at the *end* of
     * what remains, so a title containing the word "to" keeps it — the failure
     * this replaces removed every "to" in the sentence, turning "add breakfast
     * to my calendar" into "add breakfast my calendar".
     */
    .replace(/[\s,\-–—]*(?:\bfrom|\bto|\buntil|\btill|-|–|—)[\s,\-–—]*$/i, " ")
    .replace(/^[\s,\-–—]+|[\s,\-–—]+$/g, "")
    .replace(/\b(at|on|by|for|due|from)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Local calendar day key for a parsed time, for display. */
export function dayKeyOf(date: Date): string {
  return toDateKey(date);
}
