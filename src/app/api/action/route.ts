/**
 * POST /api/action — one-tap buttons on Xana's cards.
 *
 * The UI builds an `ActionIntent` (usually straight off a nudge or pattern) and
 * posts it here. The same executor the chat path uses handles it, so a tap and
 * a sentence produce identical effects and identical wording.
 */

import { NextResponse } from "next/server";
import type { ActionIntent } from "@/lib/core/types";
import { executeAction } from "@/lib/actions/executor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Every intent type the endpoint accepts, so a bad payload fails fast. */
const VALID_TYPES = new Set<ActionIntent["type"]>([
  "create_task",
  "complete_task",
  "create_event",
  "create_note",
  "create_reminder",
  "create_goal",
  "complete_milestone",
  "log_habit",
  "remember",
  "start_focus",
  "protect_block",
  "reflect",
  "brief_me",
  "none",
]);

export async function POST(request: Request): Promise<NextResponse> {
  let body: { action?: ActionIntent };
  try {
    body = (await request.json()) as { action?: ActionIntent };
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Expected a JSON body." }, { status: 400 });
  }

  const action = body.action;
  if (!action || typeof action !== "object" || typeof action.type !== "string") {
    return NextResponse.json(
      { error: "bad_action", message: "Expected an action object with a type." },
      { status: 400 },
    );
  }
  if (!VALID_TYPES.has(action.type)) {
    return NextResponse.json(
      { error: "unknown_action", message: `I don't know how to "${action.type}".` },
      { status: 400 },
    );
  }

  const outcome = executeAction(action);
  return NextResponse.json({ outcome }, { status: outcome.ok ? 200 : 422 });
}
