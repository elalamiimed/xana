/**
 * POST /api/health/ingest — a phone posts a day of health readings.
 *
 * The app-facing door. The handler lives in `lib/plugins/health-ingest.ts` and is
 * shared verbatim with `/xana/health/ingest`, so a phone can be pointed at
 * whichever path the network in front of it actually exposes without the two
 * drifting into different behaviour.
 *
 * `force-dynamic` because the POST writes to SQLite and must never be cached or
 * prerendered; `nodejs` because the store is a native `better-sqlite3` handle
 * that cannot run on the edge runtime.
 */

import { postHealthIngest } from "@/lib/plugins/health-ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return postHealthIngest(request);
}
