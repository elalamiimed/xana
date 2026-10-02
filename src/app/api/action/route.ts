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
import { finishAction } from "@/lib/actions/remote";

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
  "log_energy",
  "log_meal",
  "log_health",
  "remember",
  "start_focus",
  "protect_block",
  "reflect",
  "brief_me",
  // Removal. Accepted here as well as in conversation: the one-tap controls and
  // the cave use this route, and a delete that only works when spoken would be
  // the only write-back in the app with two implementations.
  "delete_task",
  "clear_tasks",
  "delete_event",
  "delete_goal",
  "forget_memory",
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

  // `executeAction` is synchronous and does the local write; `finishAction`
  // awaits the remote mirror when the write has one. Splitting them here keeps
  // the executor out of the network path, which matters because it also serves
  // the seed script and the thirteen synchronous handlers in the local mind.
  const outcome = await finishAction(executeAction(action));
  return NextResponse.json({ outcome }, { status: outcome.ok ? 200 : 422 });
}
