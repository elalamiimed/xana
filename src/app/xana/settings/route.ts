/**
 * GET/PUT /xana/settings — the canonical settings endpoint.
 *
 * Paired with `/xana/context`, this is the gateway namespace: the place a
 * future integration, a script or a second client should look. The UI talks
 * to `/api/settings`, which serves exactly the same handlers.
 */

import { getSettings, putSettings } from "@/lib/settings/endpoint";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return getSettings();
}

export async function PUT(request: Request) {
  return putSettings(request);
}
