/**
 * GET/POST /api/mic-log — the microphone flight recorder.
 *
 * The microphone path only fails inside a browser, and no browser can be run in
 * the environment this was built in. So the client posts the shape of each event
 * here and this holds them in memory, where they can be read back with a single
 * GET instead of being described second-hand.
 *
 * IN MEMORY, ON PURPOSE
 *
 * A file would persist diagnostics about a user's microphone past the point
 * where they are useful, and would need a cleanup path of its own. A bounded
 * array in the process disappears when the server restarts, which is the right
 * lifetime for "why did it not work just now".
 *
 * NOT A PUBLIC SURFACE
 *
 * It is unauthenticated, like everything else on this app's own origin, and it
 * accepts arbitrary short strings. That is acceptable for a loopback diagnostic
 * and would not be for anything reachable from a network — so if this is ever
 * exposed with `HOSTNAME=0.0.0.0`, it should be deleted rather than secured.
 * Nothing sensitive is posted to it: the client sends event names, error names,
 * state transitions and lengths, never transcript text.
 */

const MAX_LINES = 400;

interface Entry {
  at: string;
  line: string;
}

/** Module scope, so it survives across requests within one dev server. */
const entries: Entry[] = [];

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }

  const lines =
    typeof body === "object" && body !== null && Array.isArray((body as { lines?: unknown }).lines)
      ? (body as { lines: unknown[] }).lines
      : null;
  if (!lines) {
    return Response.json({ ok: false, error: "Expected { lines: string[] }." }, { status: 400 });
  }

  const at = new Date().toISOString();
  for (const line of lines) {
    if (typeof line !== "string") continue;
    entries.push({ at, line: line.slice(0, 300) });
  }
  // Bounded from the front: the newest events are the ones being chased.
  if (entries.length > MAX_LINES) entries.splice(0, entries.length - MAX_LINES);

  return Response.json({ ok: true, held: entries.length });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  // `?clear=1` starts a fresh run, which is how a "did it work that time?"
  // question gets an unambiguous answer.
  if (url.searchParams.get("clear") === "1") {
    entries.length = 0;
    return Response.json({ ok: true, cleared: true });
  }

  const limit = Number(url.searchParams.get("limit") ?? "0");
  const slice = limit > 0 ? entries.slice(-limit) : entries;

  // Plain text, so `curl` output is readable without a JSON parser in the way.
  const text = slice.map((entry) => `${entry.at}  ${entry.line}`).join("\n");
  return new Response(text.length > 0 ? `${text}\n` : "", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
