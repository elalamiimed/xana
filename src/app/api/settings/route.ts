/**
 * GET/PUT /api/settings — the UI's prefix for the settings endpoint.
 *
 * The implementation lives in `@/lib/settings/endpoint` so the canonical
 * `/xana/settings` route can serve the same thing without one route
 * re-exporting another.
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
