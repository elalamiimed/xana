/**
 * GET/POST /xana/connections — the canonical name for the connection surface.
 *
 * Paired with `/xana/context` and `/xana/settings`, this is the gateway
 * namespace: the place a script, a second client, or a future integration
 * should look. The UI talks to `/api/connections`, which serves the same
 * handlers.
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
