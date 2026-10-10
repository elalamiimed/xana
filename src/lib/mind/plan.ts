/**
 * Turning a goal into milestones, offline first.
 *
 * THE RULE THIS FILE IS BUILT AROUND
 *
 * Let the model propose structure; let deterministic code verify it; never let
 * the model assert progress.
 *
 * The evidence for that shape is one-sided. Language models decompose goals
 * *plausibly* and plan *unreliably* - the published planning benchmarks show
 * large gaps between a plan that reads well and a plan that works. But
 * `computeGoalProgress` in `./goals` already derives pace from completed
 * milestones against elapsed time, and that number is honest precisely because
 * nothing but the user ticking a step can move it. So the model is allowed to
 * suggest what the steps *are*, and is never allowed to say how far along they
 * are.
 *
 * OFFLINE IS NOT A DEGRADED MODE
 *
 * `decomposeGoal` produces a usable skeleton with no key at all: checkpoints
 * spaced back from the target date. That is not a fallback bolted on for the
 * no-network case; it is the default, and it is often the better answer, because
 * a person who named a date has already told you the cadence. The model is an
 * *upgrade* to the titles, available when configured, never required.
 *
 * MONTHLY CHECKPOINTS, NOT WEEKLY
 *
 * Weekly steps for a six-month goal produce twenty-six milestones, none of which
 * anyone reads. A goal's milestones are the things you would tell someone about
 * at dinner, and those are monthly at most. The count is capped at
 * `MAX_MILESTONES` for the same reason.
 */

import type { GoalHorizon } from "../core/types";
import { llmAvailable, llmComplete } from "./llm";

export interface MilestoneProposal {
  title: string;
  /** YYYY-MM-DD. Absent means "no date", which is a valid proposal. */
  due?: string;
  order: number;
}

/** The ceiling. Above this a plan stops being a plan and becomes a spreadsheet. */
export const MAX_MILESTONES = 8;

/**
 * The deterministic skeleton.
 *
 * Checkpoints are spaced *back from the target*: the last one lands on the date
 * the user named, because the deadline is the one date they definitely meant.
 * With no target date, the horizon supplies a span - short is six weeks, mid is
 * six months, long is a year - and the same spacing applies.
 */
export function decomposeGoal(input: {
  title: string;
  why?: string;
  targetDate?: string;
  horizon: GoalHorizon;
}): MilestoneProposal[] {
  const end = endDateFor(input.targetDate, input.horizon);
  if (!end) return [];

  const steps = stepsFor(input.horizon);
  const out: MilestoneProposal[] = [];
  const today = startOfToday();
  const spanMs = end.getTime() - today.getTime();

  for (let i = 0; i < steps; i += 1) {
    const fraction = (i + 1) / steps;
    /**
     * `fraction` is a fraction of the span, and it multiplies the span *in
     * milliseconds*.
     *
     * The first version of this line divided the span into days and then added
     * the fraction straight onto a millisecond timestamp - so every checkpoint
     * landed six, twelve, eighteen milliseconds after midnight and `toDateKey`
     * rendered all of them as today. It typechecked, it produced exactly the
     * right number of milestones in the right order, and every date was wrong in
     * the same way. The suite caught it because it asserts the dates are
     * strictly increasing and that the last one lands on the date the user
     * named; a test that only asked "does it return something" would have
     * passed, and the plan would have been useless.
     */
    const at = new Date(today.getTime() + spanMs * fraction);
    out.push({
      title: steps === 1 ? `Finish: ${input.title}` : `${ordinal(i + 1, steps)} checkpoint - ${input.title}`,
      due: toDateKey(at),
      order: i,
    });
  }
  return out;
}

/**
 * The model's version, when one is configured and its answer survives checking.
 *
 * Returns the deterministic skeleton on every failure path: no key, a timeout, a
 * refusal, unparseable output, or output that `validateMilestones` rejects. The
 * caller cannot tell the difference and does not need to, because the skeleton
 * is a legitimate answer rather than an error state.
 */
export async function decomposeGoalWithModel(input: {
  title: string;
  why?: string;
  targetDate?: string;
  horizon: GoalHorizon;
}): Promise<{ proposals: MilestoneProposal[]; by: "model" | "skeleton" }> {
  const skeleton = decomposeGoal(input);
  if (!llmAvailable() || skeleton.length === 0) return { proposals: skeleton, by: "skeleton" };

  const end = endDateFor(input.targetDate, input.horizon);
  try {
    const completion = await llmComplete(
      [
        {
          role: "system",
          content: `You break one personal goal into a few concrete milestones. Return JSON only, in exactly this shape:

{"milestones":[{"title":"short actionable phrase","due":"YYYY-MM-DD"}]}

Rules:
- Between 2 and ${MAX_MILESTONES} milestones, in order.
- Every title is something a person could actually do and tick off, not a theme. "Run 10km without stopping" is a milestone; "improve fitness" is not.
- Every due date is on or before ${end ? toDateKey(end) : "the goal's target"}. The last one lands on that date.
- No duplicate titles. No commentary, no preamble, no markdown.`,
        },
        {
          role: "user",
          content: `Goal: ${input.title}\nHorizon: ${input.horizon}${input.why ? `\nWhy they gave: ${input.why}` : ""}${input.targetDate ? `\nTarget date: ${input.targetDate}` : ""}\nToday: ${toDateKey(startOfToday())}`,
        },
      ],
      // No thinking: this is a structuring task, not a reasoning one, and the
      // thinking tokens would be pure latency.
      { maxTokens: 700, thinking: false, responseFormat: "json_object", timeoutMs: 15_000 },
    );

    const parsed = parseProposals(completion.text);
    const checked = validateMilestones(parsed, input.targetDate);
    if (checked.length < 2) return { proposals: skeleton, by: "skeleton" };
    return { proposals: checked, by: "model" };
  } catch {
    return { proposals: skeleton, by: "skeleton" };
  }
}

/**
 * The verification step. This is why a model is allowed near planning at all.
 *
 * Every rejection here is a way a model's plausible-looking answer is actually
 * unusable, and each one is dropped rather than repaired: a milestone with a
 * date past the goal's own deadline is not a typo to clamp, it is a sign the
 * model did not understand the goal, and silently moving it to the boundary
 * would hide that behind a number that looks fine.
 *
 * Returns the survivors in order, renumbered, capped at `MAX_MILESTONES`. An
 * empty array is a valid answer meaning "nothing here survived" - the caller
 * falls back to the skeleton.
 */
export function validateMilestones(
  proposals: unknown,
  targetDate?: string,
): MilestoneProposal[] {
  if (!Array.isArray(proposals)) return [];

  const end = targetDate ? parseDate(targetDate) : undefined;
  const seen = new Set<string>();
  const out: MilestoneProposal[] = [];

  for (const raw of proposals) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Record<string, unknown>;

    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    if (title.length < 3 || title.length > 160) continue;

    // Duplicates are dropped rather than merged: two milestones with the same
    // title are one milestone, and keeping both would inflate progress - the
    // user ticks one, and the goal reads 50% instead of 100%.
    //
    // The key collapses case AND internal whitespace, because a model asked for
    // a list will happily return "Run 5km" and "run  5KM" as two entries, and
    // they are plainly one thing.
    const key = title.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;

    let due: string | undefined;
    if (candidate.due !== undefined && candidate.due !== null && candidate.due !== "") {
      if (typeof candidate.due !== "string") continue;
      const parsed = parseDate(candidate.due);
      if (!parsed) continue;
      if (end && parsed.getTime() > end.getTime()) continue;
      due = toDateKey(parsed);
    }

    const order = typeof candidate.order === "number" && Number.isInteger(candidate.order) ? candidate.order : out.length;

    seen.add(key);
    out.push({ title, due, order });
    if (out.length >= MAX_MILESTONES) break;
  }

  // Renumbered densely: a model that returns orders 0, 3, 7 must not leave gaps
  // that the board renders as empty slots.
  return out
    .sort((a, b) => a.order - b.order)
    .map((m, i) => ({ ...m, order: i }));
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Milestone count per horizon. Monthly-ish, and never a wall of steps. */
function stepsFor(horizon: GoalHorizon): number {
  switch (horizon) {
    case "short":
      return 3;
    case "mid":
      return 5;
    case "long":
      return 6;
  }
}

/** The goal's end date: the user's, or the horizon's span. */
function endDateFor(targetDate: string | undefined, horizon: GoalHorizon): Date | undefined {
  if (targetDate) {
    const parsed = parseDate(targetDate);
    if (parsed && parsed.getTime() > Date.now()) return parsed;
  }
  const days = horizon === "short" ? 42 : horizon === "mid" ? 182 : 365;
  return new Date(startOfToday().getTime() + days * 86_400_000);
}

/** Midnight today, in local time. Never UTC: the deadline is the user's. */
function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * A date from a string, or undefined.
 *
 * `YYYY-MM-DD` is parsed as *local* midnight rather than through `new Date(str)`,
 * which treats a bare date as UTC midnight and therefore lands on the previous
 * day for anyone west of Greenwich. That off-by-one is the classic briefing bug
 * this project has already been bitten by once, and a milestone due "the 15th"
 * showing as the 14th is the same defect in a smaller place.
 */
function parseDate(value: string): Date | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (iso) {
    const [, y, m, d] = iso;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? undefined : fallback;
}

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function ordinal(index: number, total: number): string {
  if (index === 0) return "First";
  if (index === total - 1) return "Last";
  return `${index + 1}${suffix(index + 1)}`;
}

function suffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/** Read the model's JSON defensively; a refusal or prose is not an error here. */
function parseProposals(text: string): unknown[] {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      const list = (parsed as Record<string, unknown>).milestones;
      if (Array.isArray(list)) return list;
    }
    return [];
  } catch {
    return [];
  }
}
