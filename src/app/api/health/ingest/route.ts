/**
 * GET  /api/health/ingest — the device token, for the Connections panel.
 * POST /api/health/ingest — a phone posts a day of health readings.
 *
 * The app-facing door. The handlers live in `lib/plugins/health-ingest.ts` and
 * are shared verbatim with `/xana/health/ingest`, so a phone can be pointed at
 * whichever path the network in front of it actually exposes without the two
 * drifting into different behaviour.
 *
 * The GET is how the panel can honestly say "Xana generates one for you": the
 * mint happens there, behind an explicit request, rather than during the
 * connection list — a read that writes a secret into a response the rest of the
 * app treats as safe is a worse trade than one extra call. It mints nothing
 * while the endpoint is off, and never echoes a token that came from the
 * environment.
 *
 * `force-dynamic` because the POST writes to SQLite and must never be cached or
 * prerendered; `nodejs` because the store is a native `better-sqlite3` handle
 * that cannot run on the edge runtime.
 */

import { getHealthDeviceToken, postHealthIngest } from "@/lib/plugins/health-ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return getHealthDeviceToken();
}

export async function POST(request: Request) {
  return postHealthIngest(request);
}
