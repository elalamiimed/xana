/**
 * GET /api/connections/google/callback — where Google sends the browser back.
 *
 * The second half of the OAuth flow started by `POST /api/connections` with
 * `action: "connect"`. The handler itself lives in `lib/plugins/google-callback`
 * so this route and the pre-rename one share one implementation; see that file
 * for why the redirect path is passed in rather than hardcoded.
 */

import { handleGoogleCallback } from "@/lib/plugins/google-callback";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleGoogleCallback(request, "/api/connections/google/callback");
}
