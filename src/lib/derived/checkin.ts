/**
 * The check-in: the pass that decides whether to speak first.
 *
 * WHAT WAS MISSING
 *
 * `derived/proactive.ts` answers "is this worth interrupting for, right now" and
 * reports a reason for every candidate. What did not exist was anything that
 * *asked* it - so Xana never volunteered a sentence, and the whole decision layer
 * was a well-tested opinion nobody consulted.
 *
 * This is the thing that asks. It gathers what the rest of the app already
 * computed, scores it, respects the budget, and records what it said.
 *
 * WHY THIS IS A SCRIPT AND NOT A TIMER
 *
 * The obvious implementation is `setInterval` inside the Next process. It is
 * rejected for three concrete reasons, and they are worth stating because the
 * next person will reach for it:
 *
 *   1. **It does not survive.** `next dev` reloads modules on every edit and
 *      `next start` is restarted by whatever supervises it. A timer in either is
 *      a timer that stops silently.
 *   2. **It fights the database.** This app uses one SQLite writer. A timer that
 *      wakes in-process, in parallel with a request that is mid-transaction,
 *      spends `busy_timeout` for no reason.
 *   3. **It is unanswerable.** "Why did she say that at 3am" has no answer if the
 *      only record is a process that has since restarted.
 *
 * A script invoked by Task Scheduler, cron, or a systemd timer has none of those
 * properties, and `scripts/schedule.ts` is that script.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not generate the text. Every sentence here was written by
 * `derived/nudges.ts` from measured data - a task past its date, an event in
 * forty minutes, a habit at risk. A pass that *wrote* new sentences with a model
 * would be a pass that could invent something at 3am with nobody watching, and
 * the whole point of the budget and the quiet hours is that she is trustworthy
 * when nobody is looking.
 */

import type { LifeState } from "../core/types";
import { getStore, type XanaStore } from "../core/store";
import { dateKeyInZone } from "../core/zone";
import {
  decideProactive,
  interruptionCost,
  timeRelevance,
  type ProactiveCandidate,
  type ProactiveDecision,
} from "./proactive";

export interface CheckInOptions {
  now?: Date;
  store?: XanaStore;
  /** Skip the write. Used by the endpoint and by tests. */
  dryRun?: boolean;
  /** Most in a day. Defaults to the scorer's own default. */
  budgetPerDay?: number;
}

export interface CheckInResult {
  /** The Beijing day the budget was measured against. */
  day: string;
  /** What she should say, best first. Empty is a normal answer. */
  deliver: Array<{ kind: string; text: string; utility: number }>;
  /** Every candidate and the reason for its verdict, including suppressions. */
  considered: Array<{ kind: string; text: string; utility: number; deliver: boolean; reason: string }>;
  /** How much of the budget was already spent before this pass ran. */
  spentToday: number;
  budgetPerDay: number;
  /** True when the pass was scored but nothing was recorded. */
  dryRun: boolean;
}

/**
 * Everything the app already measured, offered to the scorer.
 *
 * Nothing is invented here. Each candidate is a fact some other module derived
 * and a sentence some other module wrote; this function's only job is to say what
 * it is and how urgent it looks.
 */
export function candidatesFrom(state: LifeState, now: Date): ProactiveCandidate[] {
  const relevance = timeRelevance(now);
  const cost = interruptionCost(now, state);
  const out: ProactiveCandidate[] = [];

  /**
   * The nudges the derived layer already produced.
   *
   * Their text is used verbatim. A second implementation of "what is worth
   * mentioning" would be a second thing to keep in step with the first, and the
   * first is already covered by its own suite.
   *
   * `priority` is on no documented scale, so it is read only as "some is more
   * than none" and `tone: "warn"` likewise - neither is converted into a precise
   * number, because there is no scale to convert from.
   */
  for (const nudge of state.nudges) {
    let r = relevance;
    if (nudge.priority > 0) r += 0.1;
    if (nudge.tone === "warn") r += 0.15;
    out.push({ kind: "nudge", text: nudge.text, relevance: Math.min(1, r), interruptionCost: cost });
  }

  /**
   * Overdue work.
   *
   * `state.tasks.overdue` is already filtered by the derived layer, so anything
   * in it is a measured fact. Relevance rises with the size of the pile: one
   * late item is a note, five is a pattern.
   */
  if (state.tasks.overdue.length > 0) {
    const count = state.tasks.overdue.length;
    const titles = state.tasks.overdue.slice(0, 3).map((t) => t.title);
    out.push({
      kind: "goal-drift",
      text:
        count === 1
          ? `"${titles[0]}" is past its date.`
          : `${count} things are past their date: ${titles.join(", ")}${count > 3 ? ", and more" : ""}.`,
      relevance: Math.min(1, relevance + 0.1 * count),
      interruptionCost: cost,
    });
  }

  /**
   * A goal that has stopped moving.
   *
   * `pace` is arithmetic - completed milestones against elapsed time - which is
   * exactly why it can be trusted to trigger an unprompted sentence. Nobody had
   * to judge whether this was worth mentioning; the numbers say so.
   */
  for (const { goal, progress } of state.goals.slice(0, 6)) {
    if (progress.pace !== "stalled" && progress.pace !== "slipping") continue;
    out.push({
      kind: "goal-drift",
      text: `${goal.title} is ${progress.pace} - ${progress.note}`,
      relevance: Math.min(1, progress.pace === "stalled" ? relevance + 0.15 : relevance),
      interruptionCost: cost,
    });
  }

  /**
   * A habit about to miss its week.
   *
   * `atRisk` is computed against the target and the days left, so this fires on
   * "you need two more by Sunday", not on "you have not done it today" - the
   * second is a nag, and the difference between the two is the whole reason
   * `derived/habits.ts` computes it that way.
   */
  for (const habit of state.habits) {
    if (!habit.atRisk) continue;
    const remaining = Math.max(0, habit.targetPerWeek - habit.thisWeek);
    out.push({
      kind: "intention",
      text: `${habit.name} needs ${remaining} more this week to hold${habit.streak > 1 ? ` the ${habit.streak}-day run` : ""}.`,
      relevance: Math.min(1, relevance + 0.05),
      interruptionCost: cost,
    });
  }

  return out;
}

/**
 * Run the pass.
 *
 * Scoring is always done; recording is what `dryRun` suppresses. That split is
 * deliberate - an endpoint that only scores must be able to show what *would*
 * have been said, or nobody can debug why she is quiet.
 */
export function runCheckIn(state: LifeState, opts: CheckInOptions = {}): CheckInResult {
  const store = opts.store ?? getStore();
  const now = opts.now ?? new Date();
  const day = dateKeyInZone(now);
  const budgetPerDay = opts.budgetPerDay ?? 3;

  const already = store.proactiveToday(day);
  const spentToday = already.length;
  const saidToday = new Set(already.map((p) => p.dedupeKey));

  const candidates = candidatesFrom(state, now);

  /**
   * Drop anything already said today before scoring.
   *
   * Filtering before rather than after matters: a passed-over candidate would
   * otherwise sit in the `considered` list looking like it lost on utility, when
   * the truth is that it already had its turn. The reason field says which.
   */
  const unscored = candidates.filter((c) => !saidToday.has(dedupeKeyFor(c.text)));

  const decisions = decideProactive(unscored, now, state, {
    budgetPerDay,
    deliveredToday: spentToday,
  });

  const deliver = decisions
    .filter((d) => d.deliver)
    .sort((a, b) => b.utility - a.utility)
    .slice(0, Math.max(0, budgetPerDay - spentToday))
    .map((d) => ({ kind: d.candidate.kind, text: d.candidate.text, utility: Number(d.utility.toFixed(3)) }));

  if (!opts.dryRun) {
    for (const item of deliver) {
      store.logProactive({
        kind: item.kind,
        dedupeKey: dedupeKeyFor(item.text),
        text: item.text,
        utility: item.utility,
        day,
      });
    }
  }

  return {
    day,
    deliver,
    considered: [
      ...decisions.map((d) => ({
        kind: d.candidate.kind,
        text: d.candidate.text,
        utility: Number(d.utility.toFixed(3)),
        deliver: d.deliver,
        reason: d.reason,
      })),
      // Named separately, because "already said today" is a different reason for
      // silence than "not worth it" and only one of them means change something.
      ...[...saidToday].map((key) => ({
        kind: "nudge",
        text: already.find((a) => a.dedupeKey === key)?.text ?? "",
        utility: 0,
        deliver: false,
        reason: "already said today",
      })),
    ],
    spentToday,
    budgetPerDay,
    dryRun: opts.dryRun === true,
  };
}

/**
 * A stable key for a sentence.
 *
 * Not a cryptographic hash and not meant to be: this only has to make two
 * identical sentences compare equal and two different ones compare different,
 * within one day. `hash32` is already in the codebase, stable across runs and
 * platforms, and costs nothing.
 *
 * Whitespace is collapsed first so a rebuilt nudge with different spacing is not
 * treated as a new thing to say.
 */
export function dedupeKeyFor(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `p${h.toString(16)}`;
}

/** One line for a log, so a scheduled run leaves a trace. */
export function describeCheckIn(result: CheckInResult): string {
  const head = `${result.day}: ${result.deliver.length} to say, ${result.spentToday}/${result.budgetPerDay} already spent`;
  if (result.deliver.length === 0) {
    const why = result.considered.slice(0, 3).map((c) => c.reason);
    return `${head}${why.length ? ` - ${[...new Set(why)].join("; ")}` : ""}`;
  }
  return `${head}\n${result.deliver.map((d) => `  [${d.utility}] ${d.text}`).join("\n")}`;
}

/** Exported for the endpoint, which needs the same view without the write. */
export type { ProactiveDecision };
