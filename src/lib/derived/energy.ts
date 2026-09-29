/**
 * Energy forecast.
 *
 * A deliberately explainable model. Every number traces to an `evidence`
 * string, because an assistant that says "you're at 62%" without being able to
 * say why is just noise. The inputs are the ones that actually predict a day:
 * sleep last night, sleep debt held over a week, where you are in the circadian
 * curve, how loaded the calendar is, and how much deep work is queued.
 */

import type {
  CalendarEvent,
  EnergyBand,
  EnergyForecast,
  EnergyWindow,
  FocusSession,
  HealthSample,
  Task,
} from "../core/types";
import { clamp, minutesBetween, partOfDay, round } from "../core/time";

export interface EnergyInputs {
  health: HealthSample[];
  events: CalendarEvent[];
  tasks: Task[];
  focus: FocusSession[];
  now?: Date;
}

/** Trailing average of a numeric field, ignoring gaps. */
function mean(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function bandFor(score: number): EnergyBand {
  if (score >= 80) return "peak";
  if (score >= 62) return "sharp";
  if (score >= 40) return "steady";
  return "low";
}

/**
 * Circadian shape: a morning ramp, an early-afternoon dip, a late-afternoon
 * second wind, and a decline into the evening. Roughly person-independent,
 * which is why it is a fixed curve rather than a learned one.
 */
export function circadian(hour: number): number {
  const curve: Array<[number, number]> = [
    [0, 0.15], [5, 0.25], [7, 0.6], [9, 0.9], [11, 1.0],
    [13, 0.7], [14, 0.55], [16, 0.75], [18, 0.6], [21, 0.35], [24, 0.15],
  ];
  for (let i = 1; i < curve.length; i++) {
    const [h1, v1] = curve[i - 1];
    const [h2, v2] = curve[i];
    if (hour <= h2) {
      const t = (hour - h1) / (h2 - h1);
      return v1 + (v2 - v1) * t;
    }
  }
  return 0.15;
}

export function energyForecast(input: EnergyInputs): EnergyForecast {
  const now = input.now ?? new Date();
  const hour = now.getHours() + now.getMinutes() / 60;
  const evidence: string[] = [];

  /* --- Sleep: the dominant term. --- */
  const recent = input.health.slice(-7);
  const lastNight = recent[recent.length - 1];
  const sleepAvg = mean(recent.map((h) => h.sleepHours));
  const sleptHours = lastNight?.sleepHours;

  // Sleep debt against a 7.5h personal baseline, summed over the window.
  const baseline = 7.5;
  const debt = recent.reduce((acc, h) => acc + Math.max(0, baseline - (h.sleepHours ?? baseline)), 0);

  let score = 68;

  if (typeof sleptHours === "number") {
    // 7.5h is neutral; each hour either side moves ~11 points.
    score += clamp((sleptHours - baseline) * 11, -30, 16);
    evidence.push(`${round(sleptHours, 1)}h sleep last night`);
  } else {
    evidence.push("no sleep data — estimate only");
  }

  if (debt > 0.5) {
    const penalty = clamp(debt * 3.2, 0, 22);
    score -= penalty;
    evidence.push(`${round(debt, 1)}h sleep debt across the week`);
  }

  if (typeof sleepAvg === "number" && Math.abs(sleepAvg - baseline) < 0.4 && recent.length >= 4) {
    score += 4;
    evidence.push("consistent sleep timing this week");
  }

  /* --- Circadian position. --- */
  const circ = circadian(hour);
  score += (circ - 0.7) * 22;

  /* --- Calendar load: fragmenting a day costs more than it looks. --- */
  const today = input.events.filter((e) => !e.allDay);
  const meetingMinutes = today.reduce((acc, e) => acc + Math.max(0, minutesBetween(e.start, e.end)), 0);
  if (meetingMinutes > 90) {
    const penalty = clamp((meetingMinutes - 90) / 12, 0, 14);
    score -= penalty;
    evidence.push(`${Math.round(meetingMinutes / 60)}h of meetings`);
  }
  const gaps = today.length > 2 ? " · fragmented" : "";
  if (today.length > 3) evidence.push(`${today.length} scheduled blocks${gaps}`);

  /* --- Sleep quality and resting HR, when present. --- */
  const quality = mean(recent.map((h) => h.sleepQuality));
  if (typeof quality === "number") {
    score += (quality - 0.7) * 12;
    if (quality < 0.6) evidence.push("restless sleep");
  }
  const rhr = mean(recent.map((h) => h.restingHeartRate));
  const rhrBase = mean(recent.slice(0, 3).map((h) => h.restingHeartRate));
  if (typeof rhr === "number" && typeof rhrBase === "number" && rhr - rhrBase > 4) {
    score -= 6;
    evidence.push(`resting heart rate up ${Math.round(rhr - rhrBase)}bpm on the week`);
  }

  /* --- Focus history: what you have actually managed lately. --- */
  const focusMinutes = input.focus.reduce((acc, f) => acc + (f.completed ? f.minutes : 0), 0);
  if (focusMinutes > 180) {
    score += 4;
    evidence.push(`${round(focusMinutes / 60, 1)}h focused already this week`);
  }

  /* --- Mood from health, a light touch. --- */
  const moods = recent.map((h) => h.mood).filter(Boolean);
  const lastMood = moods[moods.length - 1];
  if (lastMood === "bright") score += 4;
  if (lastMood === "low") {
    score -= 8;
    evidence.push("mood has been low");
  }

  score = clamp(Math.round(score), 5, 98);
  const band = bandFor(score);
  const windows = buildWindows(score, today, hour, sleptHours);

  return {
    score,
    band,
    windows,
    note: noteFor(band, sleptHours, debt, meetingMinutes, windows, hour),
  };
}

/**
 * Split the waking day into the windows that matter, each with the confidence
 * the evidence supports. Windows already past are still returned — the UI dims
 * them, and the shape of the day is more useful than only its remainder.
 */
function buildWindows(
  score: number,
  events: CalendarEvent[],
  hour: number,
  sleptHours: number | undefined,
): EnergyWindow[] {
  const load = (start: number, end: number): number => {
    const startMs = new Date().setHours(start, 0, 0, 0);
    const endMs = new Date().setHours(end, 0, 0, 0);
    return events.reduce((acc, e) => {
      const s = new Date(e.start).getTime();
      const en = new Date(e.end).getTime();
      return acc + (s < endMs && en > startMs ? minutesBetween(e.start, e.end) : 0);
    }, 0);
  };

  const baseConfidence =
    (sleptHours !== undefined ? 0.3 : 0) + (events.length > 0 ? 0.25 : 0) + 0.25;

  const windows: EnergyWindow[] = [
    { startHour: 7, endHour: 11, label: "morning peak" },
    { startHour: 11, endHour: 14, label: "midday" },
    { startHour: 14, endHour: 17, label: "afternoon dip" },
    { startHour: 17, endHour: 20, label: "second wind" },
    { startHour: 20, endHour: 23, label: "evening" },
  ].map(({ startHour, endHour, label }) => {
    const mid = (startHour + endHour) / 2;
    const windowScore = clamp(score + (circadian(mid) - circadian(hour)) * 26 - load(startHour, endHour) / 9, 5, 98);
    const evidence: string[] = [`circadian ${round(circadian(mid), 2)}`];
    const booked = load(startHour, endHour);
    if (booked > 0) evidence.push(`${Math.round(booked)}m booked`);
    return {
      startHour,
      endHour,
      band: bandFor(windowScore),
      confidence: round(clamp(baseConfidence + (booked > 0 ? 0.15 : 0), 0.2, 0.9), 2),
      label,
      evidence,
    };
  });

  return windows;
}

/**
 * The sentence under the score.
 *
 * This used to be nine literal sentences chosen by band, which meant a 31 and
 * a 34 were told the same thing and a heavy calendar read identically at 09:00
 * and at 21:00. The band is the least interesting thing known here: it is
 * already printed beside the number, so a sentence that restates it is a
 * sentence that says nothing.
 *
 * What is worth saying, in order of how much it changes a decision:
 *
 *  1. **Where the day is going.** `windows` already computes the shape of the
 *     day, and "the afternoon is stronger than now" is the one fact that
 *     changes what someone does next. It is the reason this sentence exists.
 *  2. **What is causing it**, when the cause is specific: a short night, a
 *     week of debt, a calendar that will spend the capacity a good night
 *     bought.
 *  3. **Nothing.** When none of those is true, the note is a short statement
 *     of the band and stops. Padding it out would be the template again.
 */
function noteFor(
  band: EnergyBand,
  sleptHours: number | undefined,
  debt: number,
  meetingMinutes: number,
  windows: EnergyWindow[],
  hour: number,
): string {
  const parts: string[] = [];

  /**
   * Where the day is going, first.
   *
   * This has to lead, and an earlier version of this function got that wrong:
   * it put the cause first and stopped once it had one, so a short night
   * produced the note "On 5.5h." and said nothing about the day at all. The
   * cause is the least actionable thing here — the number it explains is
   * already printed above it. The shape of what is left is what changes a
   * decision.
   *
   * Windows carry a band rather than a score, so the comparison is ordinal.
   * That is enough: the claim is "a better stretch is coming", which does not
   * need to know by how much.
   */
  const ahead = windows.filter((w) => w.endHour > hour);
  const best = ahead.slice().sort((a, b) => bandRank(b.band) - bandRank(a.band))[0];

  if (best && best.startHour > hour && best.band === "peak") {
    parts.push(`${best.label} at ${best.startHour}:00 is the strongest stretch.`);
  } else if (best && best.startHour > hour && bandRank(best.band) > bandRank(band)) {
    parts.push(`It lifts through the ${best.label}.`);
  } else if (band === "peak" || band === "sharp") {
    parts.push("Now is the strong stretch.");
  } else if (ahead.length > 0 && ahead.every((w) => w.band === "low")) {
    parts.push("No better stretch is coming today, so front-load what matters.");
  }

  // The cause, when there is a specific one worth naming. A short night is
  // stated plainly because it is a fact about last night, not a diagnosis.
  if (typeof sleptHours === "number" && sleptHours < 6) {
    parts.push(`You slept ${sleptHours.toFixed(1)}h.`);
  } else if (debt > 6) {
    parts.push(`${debt.toFixed(1)}h of debt behind you.`);
  } else if (meetingMinutes > 180) {
    parts.push(`${Math.round(meetingMinutes / 60)}h booked.`);
  } else if (band === "peak" && meetingMinutes > 120) {
    parts.push(`The calendar will spend ${Math.round(meetingMinutes / 60)}h of it.`);
  }

  if (parts.length === 0) {
    return band === "low"
      ? "Low reserves."
      : band === "peak"
        ? "Strong day."
        : band === "sharp"
          ? "Clear enough for demanding work."
          : "A maintenance day.";
  }

  return parts.join(" ");
}

/** Ordering for "is this window better than now", low to peak. */
function bandRank(band: EnergyBand): number {
  if (band === "peak") return 3;
  if (band === "sharp") return 2;
  if (band === "steady") return 1;
  return 0;
}

/** Morning vs afternoon completion ratio — feeds the pattern detector. */
export function partOfDayOf(iso: string): "night" | "morning" | "afternoon" | "evening" {
  return partOfDay(new Date(iso));
}
