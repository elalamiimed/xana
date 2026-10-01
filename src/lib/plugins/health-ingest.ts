/**
 * POST /api/health/ingest and POST /xana/health/ingest — one handler, two doors.
 *
 * A phone on the same Wi-Fi has no session, no cookie and no interest in the
 * browser UI, so the LAN-facing route is the same code as the app-facing one
 * rather than a second, thinner implementation that could drift into accepting
 * something the other refuses. Both route files below are three lines; every
 * decision lives here, where it can be read in one place.
 *
 * THE AUTHORISATION MODEL, IN ONE PARAGRAPH
 *
 * The device token is the grant. `local.read` describes Xana reading a folder
 * the user named, which is not what a POST from a phone is, so requiring it here
 * would be a permission that means nothing and gets clicked through. What
 * protects the endpoint is that the token exists only in two places — the
 * settings file on this machine, and the phone the user pasted it into — that it
 * is compared in constant time, and that it is *never* included in a response.
 * The health plugin's own folder half stays ungranted and irrelevant: this path
 * writes to Xana's own SQLite and reads nothing but the request body.
 *
 * WHY THE STATUS CODES ARE WHAT THEY ARE
 *
 * A phone shortcut surfaces the status code and the message, and its owner is
 * the person who configured it, so each refusal names the thing to fix. All of
 * them describe the request; none of them confirm or deny anything about the
 * stored token beyond "that is not it".
 */

import { NextResponse } from "next/server";

import { credential } from "../settings/store";
import {
  DEVICE_TOKEN_KEY,
  deviceToken,
  ingest,
  ingestEnabled,
  normalizePayload,
  refreshHealth,
  tokenMatches,
} from "./health-bridge";

/** The header a shortcut sets. A body field is accepted too — see `tokenFrom`. */
const TOKEN_HEADER = "x-device-token";

export interface IngestResponse {
  ok: true;
  days: number;
  lastDay: string;
}

function fail(status: number, message: string): NextResponse {
  return NextResponse.json({ ok: false, message }, { status });
}

/**
 * The presented token, from the header or from the body.
 *
 * Both spellings are accepted because both are natural: a Shortcut that sets a
 * header keeps the token out of the JSON it pastes into a log, while a shell
 * `curl -d '{"token":"…"}'` is the shortest thing that works. Neither path is
 * more privileged than the other — they meet at `tokenMatches`.
 */
function tokenFrom(request: Request, body: Record<string, unknown> | undefined): string {
  const header = request.headers.get(TOKEN_HEADER);
  if (typeof header === "string" && header.trim().length > 0) return header.trim();
  const fromBody = body?.["token"];
  return typeof fromBody === "string" ? fromBody : "";
}

/**
 * Accept one post.
 *
 * Order of checks matters and is deliberate: the switch is consulted *after* the
 * token, so a caller without the token cannot use this endpoint to find out
 * whether phone ingest is on in the first place.
 */
export async function postHealthIngest(request: Request): Promise<NextResponse> {
  /**
   * Read the body as text first, so "this was not JSON" is reported as a 400
   * about the body rather than whatever `request.json()` throws. The text is
   * only parsed, never stored or logged.
   */
  let text: string;
  try {
    text = await request.text();
  } catch {
    return fail(400, "Could not read that request body.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return fail(400, "That request body was not JSON.");
  }

  const body =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;

  /**
   * Missing token and wrong token are different refusals on purpose. A shortcut
   * whose header was never configured needs to hear "no device token"; one whose
   * token has gone stale needs to hear "that token is not right". The 403 body
   * says nothing else — not the expected length, not a prefix, not the token.
   */
  const given = tokenFrom(request, body);
  if (given.length === 0) {
    return fail(400, "No device token");
  }
  if (!tokenMatches(given)) {
    return fail(403, "That token is not right.");
  }

  if (!ingestEnabled()) {
    return fail(409, "Phone ingest is off.");
  }

  const { samples, rejected } = normalizePayload(parsed);
  if (samples.length === 0) {
    return fail(
      400,
      rejected > 0
        ? `No usable samples in that body (${rejected} rejected). Each needs a date like "2026-01-01" and at least one reading.`
        : "No usable samples in that body. Send an object, an array, or {samples: [...]}.",
    );
  }

  const { days, lastDay } = ingest(samples);

  /**
   * Awaited, unlike the fire-and-forget inside `ingest`, because this response
   * is the signal that the reading is live: the phone's next move is plausibly to
   * pull the life state, and a cached state that predates the post would make the
   * whole feature look broken for the length of an adapter TTL.
   */
  await refreshHealth();

  const response: IngestResponse = { ok: true, days, lastDay: lastDay ?? samples[0].date };
  return NextResponse.json(response);
}

/* ------------------------------------------------------------------ */
/* Handing the token to the panel                                      */
/* ------------------------------------------------------------------ */

/**
 * The token, for the one page allowed to show it.
 *
 * WHY THIS IS A SEPARATE CALL AND NOT PART OF THE CONNECTION LIST
 *
 * The panel used to say "leave it empty and Xana generates one", and that was
 * not true: nothing minted a token until `tokenMatches` ran, and a token is
 * needed to reach the code that runs it. A token minted during `GET
 * /api/connections` would fix the symptom and break two rules — a read would
 * write to the settings file, and the secret would sit in a response the rest
 * of the app treats as safe to log or cache.
 *
 * So the mint lives here, on its own path, and it is asked for deliberately:
 *
 *  - **Nothing is written unless the endpoint is on.** With `health.ingest` off
 *    there is no bridge to authorise, so the answer says so and no token is
 *    created. Turning the feature on is what creates one, which is the same
 *    "the user asked for this" consent the POST path relies on.
 *  - **An environment token is never echoed.** `credential()` is consulted
 *    first, and a value that came from the environment is reported as
 *    `from: "env"` with no `token` field. Xana reads the environment; she does
 *    not print it back into a page.
 *  - **A stored token is the user's**, whether they typed it or Xana generated
 *    it on an earlier visit. This path never replaces a value that exists.
 *
 * The value is a bearer secret for a LAN endpoint, so the one page that shows
 * it is the page on this machine whose whole purpose is to hand it to a phone.
 * It is deliberately not part of `GET /api/connections`, and the token itself
 * never appears in an ingest response.
 */
export function getHealthDeviceToken(): NextResponse {
  if (!ingestEnabled()) {
    return NextResponse.json({
      ok: true,
      enabled: false,
      from: "none" as const,
      message:
        'Phone ingest is off. Put "on" in the accept-posts field to open the endpoint and get a token.',
    });
  }

  const found = credential(DEVICE_TOKEN_KEY);
  if (found.present) {
    return NextResponse.json({
      ok: true,
      enabled: true,
      from: found.from,
      // The escape hatch for a headless install: a value from the environment
      // is what the phone must send, and this route will not repeat it.
      token: found.from === "settings" ? found.value : undefined,
      message:
        found.from === "settings"
          ? "This is the token your phone sends."
          : "The token is set in your environment. Use that value — it is not echoed here.",
    });
  }

  // Nothing stored and nothing exported: mint one now, persist it, and show it.
  const token = deviceToken();
  return NextResponse.json({
    ok: true,
    enabled: true,
    from: "settings" as const,
    token,
    message: "A token was generated and saved. Your phone sends this.",
  });
}
