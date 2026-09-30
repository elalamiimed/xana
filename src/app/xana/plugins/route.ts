/**
 * GET/POST /xana/plugins — the canonical name for the plugin surface.
 *
 * Paired with `/xana/context` and `/xana/settings`, this is the gateway
 * namespace: the place a script, a second client, or a future integration
 * should look. The UI talks to `/api/plugins`, which serves the same handlers.
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
