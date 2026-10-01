/**
 * GET/POST /xana/health/ingest — the same ingest, on the path the app already uses.
 *
 * Every other route the UI talks to lives under `/xana` (`/xana/context`,
 * `/xana/settings`, `/xana/connections`), while `/api` holds the surface that
 * external callers point at. A phone is an external caller, so both paths are
 * offered and both run the identical handlers from `lib/plugins/health-ingest.ts`.
 * Two implementations would be two chances to accept something the other refuses,
 * and the refusal rules here are the whole security story. The GET is the token
 * hand-off the panel asks for; it mints nothing while the endpoint is off.
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
