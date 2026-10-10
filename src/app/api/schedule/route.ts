/**
 * GET /api/schedule - what, if anything, is worth saying right now.
 *
 * WHY THIS IS A ROUTE AND NOT A TIMER
 *
 * The decision - whether an interruption is worth making, and how much of today's
 * budget is left - lives in `src/lib/derived/checkin.ts`, and the pass that
 * *acts* on it is `scripts/schedule.ts`, run by whatever already runs things on
 * the machine. Neither is a timer inside this process, for three reasons: a
 * timer here does not survive a module reload or a restart and stops silently;
 * it wakes in parallel with request handlers against a single SQLite writer and
 * spends `busy_timeout` for nothing; and "why did she say that at 3am" becomes
 * unanswerable once the process that decided it is gone.
 *
 * This route is the read-only view of the same decision, for the interface and
 * for anyone debugging why she is quiet. It shares `runCheckIn` with the script
 * rather than reimplementing it - two implementations of "what is worth saying"
 * would be two things to keep in step, and the first one to drift would be the
 * one nobody was looking at.
 *
 * A DRY RUN, ALWAYS. This endpoint never records and never spends budget. A GET
 * that consumes a resource is a GET that cannot be retried, and a browser
 * prefetch or a monitoring probe would silently eat the day's allowance - so the
 * write belongs to the explicit, scheduled script and nowhere else.
 */

import { NextResponse } from "next/server";
import { buildLifeState } from "@/lib/context/gateway";
import { runCheckIn } from "@/lib/derived/checkin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  try {
    const state = await buildLifeState();
    const result = runCheckIn(state, { dryRun: true });

    return NextResponse.json({
      /** The Beijing day the budget is measured against. */
      day: result.day,
      /** What she would say, best first. Empty is a normal and correct answer. */
      deliver: result.deliver,
      /** How much of today's allowance is already gone. */
      spentToday: result.spentToday,
      budgetPerDay: result.budgetPerDay,
      inQuietHours: result.considered.some((c) => /quiet hours/.test(c.reason)),
      /** Every candidate and why it was kept or dropped. */
      considered: result.considered,
      /**
       * Said in the payload as well as in the docs, because a caller reading
       * this needs to know it changed nothing.
       */
      note: "Read-only - this endpoint records nothing and spends no budget. The pass that speaks is `npm run schedule`, run by your own scheduler. The budget is fixed; the ignored-signal that would tune it is not measured yet.",
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "schedule.failed",
        message: err instanceof Error ? err.message : "Could not work out what to say.",
      },
      { status: 500 },
    );
  }
}
