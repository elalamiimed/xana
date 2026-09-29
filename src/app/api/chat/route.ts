/**
 * POST /api/chat — say something to Xana.
 *
 * Flow: assemble the life state (once, and share it with the reply), resolve
 * the intent, let the chosen engine write her sentence, and return both the
 * message and the refreshed life state so the UI never has to make a second
 * round trip to stay in sync.
 */

import { NextResponse } from "next/server";
import type { ChatRequest } from "@/lib/core/types";
import { buildLifeState } from "@/lib/context/gateway";
import { think } from "@/lib/mind";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  let body: Partial<ChatRequest>;
  try {
    body = (await request.json()) as Partial<ChatRequest>;
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Expected a JSON body." },
      { status: 400 },
    );
  }

  const message = typeof body.message === "string" ? body.message : "";
  if (message.trim().length === 0) {
    return NextResponse.json(
      { error: "empty_message", message: "Say something and I'll answer." },
      { status: 400 },
    );
  }
  if (message.length > 4000) {
    return NextResponse.json(
      { error: "message_too_long", message: "That's longer than I can hold at once." },
      { status: 413 },
    );
  }

  try {
    const lifeState = await buildLifeState();
    const result = await think(
      {
        message,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        modality: body.modality === "voice" ? "voice" : "text",
      },
      lifeState,
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        error: "chat.failed",
        message: err instanceof Error ? err.message : "Something broke on my side.",
      },
      { status: 500 },
    );
  }
}
