/**
 * GET /api/connections  — every connection, its capabilities, and its last read.
 * POST /api/connections — grant, revoke, connect, disconnect.
 *
 * The canonical surface. Xana used to have two names for one idea: "Plugins"
 * held the API keys and the permission cards, "Connections" held the legacy
 * `XANA_*` values, and neither screen was the place you looked for everything
 * she can reach. They are one list now, grouped by what it takes to connect
 * — your data, a service, a device, or something bundled.
 *
 * `/api/plugins` still answers, because a script or a bookmark that pointed at
 * it should keep working. It re-exports these handlers, so the two paths cannot
 * drift into different behaviour.
 */

import { getConnections, postConnections } from "@/lib/plugins/endpoint";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return getConnections();
}

export async function POST(request: Request) {
  return postConnections(request);
}
