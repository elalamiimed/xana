/**
 * GET/POST /api/cave, and the canonical /xana/cave.
 *
 * One endpoint for every mutation in My cave and the memory screen. The
 * operations are fixed and small (`goal.move`, `memory.pin`), so a single
 * route with a dispatch table beats two dozen files that would each repeat
 * the same parse, validate, invalidate, respond sequence.
 *
 * GET answers the two things the screens need to open: the goal board with
 * its computed pace, and a page of memories with their counts.
 */

import { NextResponse } from "next/server";

import {
  CaveError,
  isCaveOperation,
  listCaveGoals,
  listMemories,
  runCaveOperation,
} from "@/lib/cave/ops";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const memoryLimit = Number(url.searchParams.get("memories") ?? 300);

  try {
    const memories = listMemories({ limit: memoryLimit }).memories;
    return NextResponse.json({ goals: listCaveGoals(), memories });
  } catch (err) {
    return failure(err);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "That request body was not JSON." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Expected an object." }, { status: 400 });
  }

  const { op, ...input } = body as { op?: unknown } & Record<string, unknown>;

  if (!isCaveOperation(op)) {
    return NextResponse.json(
      {
        error: "Unknown operation.",
        // Naming the valid set is more useful than "invalid", and this route
        // is one a script may drive.
        valid: [
          "goal.create",
          "goal.update",
          "goal.delete",
          "goal.move",
          "goal.touch",
          "milestone.create",
          "milestone.setDone",
          "milestone.update",
          "milestone.delete",
          "memory.list",
          "memory.create",
          "memory.update",
          "memory.pin",
          "memory.forget",
        ],
      },
      { status: 400 },
    );
  }

  try {
    const payload = runCaveOperation(op, input);
    // The board is cheap to recompute and returning it saves the client a
    // second round trip after every edit, which is what makes the cave feel
    // immediate rather than laggy.
    return NextResponse.json({ ok: true, ...payload, goals: listCaveGoals() });
  } catch (err) {
    return failure(err);
  }
}

/**
 * A `CaveError` is something the user can act on, so it keeps its message
 * and its status. Anything else is a bug, and is reported as a 500 with a
 * generic sentence so the screen does not display a stack trace as advice.
 */
function failure(err: unknown): NextResponse {
  if (err instanceof CaveError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[xana] cave operation failed:", err);
  return NextResponse.json(
    { error: "That change could not be saved." },
    { status: 500 },
  );
}
