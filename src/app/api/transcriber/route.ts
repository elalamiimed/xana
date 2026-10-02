import {
  ensureTranscriber,
  locateTranscriber,
  planTranscriberStart,
  probeTranscriber,
} from "@/lib/stt/supervisor";

/**
 * The local transcriber, seen from the app.
 *
 * WHY THIS ROUTE EXISTS
 *
 * Only the server can start a process, and only the browser knows when the
 * service is needed — the user pressed the mic, or said her name into an engine
 * that transcribes on this machine. So the browser asks, and this is the asking
 * point. Without it the app's answer to a missing service was a sentence telling
 * the user to go and run a PowerShell script, which is the app's own dependency
 * handed back as a chore.
 *
 * GET is a status read: it starts nothing, and is safe to call on every render.
 * POST ensures the service is running, and is idempotent — the supervisor probes
 * first and rate-limits its own attempts, so the browser's three-second retry
 * loop cannot turn a broken install into a process storm.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await probeTranscriber();
  const install = locateTranscriber();
  const decision = planTranscriberStart({
    running: status.available,
    ready: status.ready,
    hasPython: install.python !== "",
    hasVenv: install.venv,
    hasModel: install.modelDir !== "",
  });

  return Response.json({
    status,
    /** What the app WOULD do, so the panel can say it before it does it. */
    action: decision.action,
    note: decision.note,
    /** Whether the pieces are on disk. Not a promise that a start will work. */
    installed: { python: install.python, venv: install.venv, model: install.modelDir },
  });
}

export async function POST(request: Request) {
  /**
   * A JSON content type is required, and it is a guard rather than a formality.
   *
   * A browser will send a cross-origin `text/plain` POST without asking first, so
   * any page on the internet could otherwise make this machine spawn a process.
   * A JSON body is not a CORS-safelisted content type, so it needs a preflight —
   * and this route answers no preflight, because nothing outside the app has any
   * business calling it.
   */
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return Response.json(
      { error: "This route starts a local service and accepts only application/json." },
      { status: 415 },
    );
  }

  const result = await ensureTranscriber();
  return Response.json({
    action: result.action,
    started: result.started,
    note: result.note,
    status: result.status,
  });
}
