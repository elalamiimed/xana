/**
 * GET /api/plugins/google/callback — the pre-rename address of the callback.
 *
 * Kept for two reasons: a sign-in started before the rename still has to
 * finish, and a Google Cloud project may already have this redirect URI
 * registered. It runs the same handler as `/api/connections/google/callback`,
 * passing its own path so the code exchange uses the redirect that was
 * authorized.
 */

import { handleGoogleCallback } from "@/lib/plugins/google-callback";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleGoogleCallback(request, "/api/plugins/google/callback");
}
