/**
 * GET /api/context — alias for the life-state gateway.
 *
 * `/xana/context` is the canonical endpoint named in the architecture. This
 * alias exists because the UI's HTTP contract (`src/lib/api/contract.ts`) uses
 * the `/api` prefix like every other route, and having the briefing 404 on a
 * prefix mismatch is a silly way to lose an afternoon.
 *
 * Both paths return identical payloads from the same cached assembly, so
 * neither is more authoritative than the other.
 */

import { NextResponse } from "next/server";
import { buildLifeState } from "@/lib/context/gateway";
import { analyseLifeState } from "@/lib/mind/analysis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";
    const lifeState = await buildLifeState({ force });
    // Loaded on mount and explicit refreshes, never by the five-second
    // presence poll, so a configured model can enrich Pattern without turning
    // ambient polling into repeated API spend.
    const analysis = await analyseLifeState({ lifeState });
    return NextResponse.json({ lifeState, analysis });
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
