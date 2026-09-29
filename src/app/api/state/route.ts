/**
 * GET /api/state — the cheap ambient poll.
 *
 * Returns presence and a one-line summary rather than the whole life state,
 * because the orb refreshes this every few seconds and should cost almost
 * nothing. It reads cached adapter statuses and never triggers I/O of its own;
 * the first call of a session warms the cache so there is something to report.
 */

import { NextResponse } from "next/server";
import type { StateResponse } from "@/lib/api/contract";
import { buildLifeState, summarise } from "@/lib/context/gateway";
import { currentEngine } from "@/lib/mind";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse<StateResponse | { error: string }>> {
  try {
    // buildLifeState is TTL-cached, so this stays cheap on repeat calls.
    const lifeState = await buildLifeState();
    const summary = summarise(lifeState);

    // Presence at rest. The UI overrides this locally while it is sending or
    // receiving, because only the client knows when she is thinking or speaking.
    const body: StateResponse = {
      presence: "idle",
      headline: summary.headline,
      partOfDay: lifeState.partOfDay,
      energy: { score: lifeState.energy.score, band: lifeState.energy.band },
      attention: summary.attention,
      engine: currentEngine(),
      generatedAt: lifeState.generatedAt,
    };

    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "state.failed" },
      { status: 500 },
    );
  }
}
