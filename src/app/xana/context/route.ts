/**
 * GET /xana/context — the unified life-state gateway.
 *
 * One endpoint that aggregates every life-data source into the single object
 * Xana reads before she responds: calendar, tasks, habits, goals, health,
 * weather, media, markets, mail, detected patterns, nudges, energy and recalled
 * memory. Everything else in the system is downstream of this.
 */

import { NextResponse } from "next/server";
import { buildLifeState } from "@/lib/context/gateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";
    const lifeState = await buildLifeState({ force });
    return NextResponse.json({ lifeState });
  } catch (err) {
    return NextResponse.json(
      {
        error: "context.failed",
        message: err instanceof Error ? err.message : "Could not assemble the life state.",
      },
      { status: 500 },
    );
  }
}
