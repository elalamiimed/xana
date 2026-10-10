/**
 * Should she say anything, and is now the moment?
 *
 * THE FRAMEWORK
 *
 * Horvitz's expected-value rule for when an interruption is worth making, which
 * is old and still the right shape:
 *
 *     E[U] = P(relevant | now, context) x benefit
 *            - (1 - P(relevant | now, context)) x cost_of_interrupting
 *
 * It is worth being explicit about why this is a *function* rather than a
 * schedule. A nightly job that generates a briefing is easy and it is also how
 * an assistant becomes a notification source people learn to dismiss. The
 * difference between the two is not the content, it is the timing: the same
 * sentence is useful at 7am on a quiet morning and hostile at 7am with a meeting
 * in ten minutes.
 *
 * WHAT MAKES P(RELEVANT) HONEST
 *
 * Every input here is something the app already measures - the calendar, the
 * focus session, the hour, the day of the week, the mood reading. Nothing is
 * inferred from a model, and nothing is guessed. That matters because this
 * function's output is a decision to speak, and a decision to speak made from an
 * invented input is an interruption with no reason behind it.
 *
 * THE ONE NUMBER THAT IS MISSING, AND WHY IT IS NAMED
 *
 * The signal that actually tunes this over time is **ignored**: a suggestion
 * shown and never acted on is the only feedback that says "you showed me this
 * and I did not care". It is not used here, because measuring it needs a
 * scheduled sweep that records when a surfaced nudge went unanswered, and that
 * sweep does not exist yet. Pretending otherwise - by, say, treating a dismissed
 * nudge as a negative signal - would tune on the wrong thing, since a nudge the
 * user read and silently acted on looks identical to one they ignored. So the
 * budget is fixed and conservative, and the adaptive version is left for the
 * pass that can measure it.
 */

import type { LifeState } from "../core/types";

export interface ProactiveCandidate {
  kind: "briefing" | "reflection" | "goal-drift" | "intention" | "nudge";
  text: string;
  /** 0..1 - how likely this is to matter to them right now. */
  relevance: number;
  /** 0..1 - how much it costs to interrupt at this moment. */
  interruptionCost: number;
  /** 0..1 - how much good it does when it lands. */
  benefit?: number;
}

export interface ProactiveDecision {
  candidate: ProactiveCandidate;
  utility: number;
  deliver: boolean;
  reason: string;
}

export interface ProactiveOptions {
  /** Inclusive start and exclusive end hour, local. Default 22:00 to 07:00. */
  quietHours?: [number, number];
  /** Most messages in a day before she stops volunteering things. */
  budgetPerDay?: number;
  /** How many have already gone out today. */
  deliveredToday?: number;
  /**
   * Whether a focus session is running.
   *
   * Passed in rather than read from the life state, because it is not there to
   * be read. A focus session lives in the store; the nearest thing in the state
   * is `energy.windows`, which are *forecast* hours (startHour/endHour, 0-23)
   * and mean "your concentration is good in this range", not "do not disturb me
   * now". Treating a forecast window as a focus session would silence her for
   * the several hours a day the forecast happens to call sharp, which is close
   * to the opposite of what those hours are for.
   */
  inFocusSession?: boolean;
}

/** Below this, silence. Tuned to be hard to clear rather than easy to clear. */
export const DEFAULT_THRESHOLD = 0.18;

/**
 * Score each candidate and say whether to deliver it.
 *
 * Every decision carries a `reason`, including the suppressions. That is not
 * decoration: an assistant that goes quiet for a week and cannot say why is
 * undebuggable, and "it was quiet hours" is a different bug from "nothing scored
 * high enough".
 */
export function decideProactive(
  candidates: ProactiveCandidate[],
  now: Date,
  state?: LifeState,
  opts: ProactiveOptions = {},
): ProactiveDecision[] {
  const [quietStart, quietEnd] = opts.quietHours ?? [22, 7];
  const budget = opts.budgetPerDay ?? 3;
  const used = opts.deliveredToday ?? 0;

  const inQuietHours = isQuiet(now.getHours(), quietStart, quietEnd);
  const inMeeting = state ? inEventNow(state, now) : false;
  const focussing = opts.inFocusSession === true;

  return candidates.map((candidate) => {
    const benefit = candidate.benefit ?? 1;
    const p = clamp01(candidate.relevance);
    const cost = clamp01(candidate.interruptionCost);

    // Horvitz, literally. The cost term is weighted by the chance this is NOT
    // relevant, which is what stops a highly-relevant item from being suppressed
    // by a high cost: a 0.95-relevant thing is worth interrupting for, and a
    // 0.2-relevant one at the same cost is not.
    const utility = p * benefit - (1 - p) * cost;

    if (inQuietHours) {
      return { candidate, utility, deliver: false, reason: `quiet hours (${quietStart}:00-${quietEnd}:00)` };
    }
    if (inMeeting) {
      return { candidate, utility, deliver: false, reason: "they are in a meeting" };
    }
    if (focussing && candidate.kind !== "intention") {
      // A focus session is the one moment the user has explicitly said "not
      // now". The exception is an intention, because its whole purpose is to
      // fire at a cue, and the cue may well be the session itself.
      return { candidate, utility, deliver: false, reason: "they are in a focus session" };
    }
    if (used >= budget) {
      return { candidate, utility, deliver: false, reason: `daily budget spent (${used}/${budget})` };
    }
    if (utility < DEFAULT_THRESHOLD) {
      return { candidate, utility, deliver: false, reason: `below threshold (${utility.toFixed(2)} < ${DEFAULT_THRESHOLD})` };
    }
    return { candidate, utility, deliver: true, reason: `worth it (${utility.toFixed(2)})` };
  });
}

/** At most `budget` deliveries, best first, so a caller cannot over-speak. */
export function selectDeliveries(decisions: ProactiveDecision[], budget = 3): ProactiveDecision[] {
  return decisions
    .filter((d) => d.deliver)
    .sort((a, b) => b.utility - a.utility)
    .slice(0, Math.max(0, budget));
}

/* ------------------------------------------------------------------ */
/* The measured inputs                                                 */
/* ------------------------------------------------------------------ */

/**
 * How likely a message is to matter right now, from the clock alone.
 *
 * Morning and early evening are when a person is between things and can read
 * something; the middle of the afternoon is when they are in the middle of
 * something. This is a crude shape and it is stated as one - the alternative is
 * a model guessing at alertness from a calendar, which is a confident answer
 * built on nothing.
 */
export function timeRelevance(now: Date): number {
  const h = now.getHours();
  if (h >= 7 && h < 9) return 0.9;
  if (h >= 9 && h < 12) return 0.5;
  if (h >= 12 && h < 14) return 0.6;
  if (h >= 14 && h < 17) return 0.3;
  if (h >= 17 && h < 20) return 0.8;
  if (h >= 20 && h < 22) return 0.4;
  return 0.1;
}

/**
 * How much an interruption costs at this moment.
 *
 * High inside a meeting or a focus session, low in the gaps. The floor is 0.05
 * rather than 0 so a genuinely urgent thing can still clear the threshold when
 * the user is busy - a cost of 1 combined with relevance below 1 makes utility
 * negative for everything, which would silence the assistant entirely during
 * exactly the periods when something might matter.
 */
export function interruptionCost(now: Date, state?: LifeState, inFocusSession = false): number {
  if (state && inEventNow(state, now)) return 0.9;
  if (inFocusSession) return 0.85;
  const h = now.getHours();
  if (h >= 9 && h < 17) return 0.4;
  if (h >= 17 && h < 19) return 0.2;
  return 0.15;
}

function inEventNow(state: LifeState, now: Date): boolean {
  const t = now.getTime();
  return state.calendar.today.some((e) => {
    const start = new Date(e.start).getTime();
    const end = new Date(e.end).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && start <= t && t < end;
  });
}

/**
 * Is `hour` inside the quiet window?
 *
 * Handles the wrap, because the default window (22:00 to 07:00) crosses
 * midnight and a naive `hour >= start && hour < end` is then never true - which
 * would mean quiet hours silently did nothing, and the first anyone would know
 * is being woken at 2am.
 */
function isQuiet(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
