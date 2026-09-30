/**
 * GET /api/plugins  — every plugin, its capabilities, and its last read.
 * POST /api/plugins — grant, revoke, connect, disconnect.
 *
 * Paired with the canonical `/xana/plugins`, which serves the same handlers.
 */

import { getPlugins, postPlugins } from "@/lib/plugins/endpoint";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return getPlugins();
}

export async function POST(request: Request) {
  return postPlugins(request);
}
