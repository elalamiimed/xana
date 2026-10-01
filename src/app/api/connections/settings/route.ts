/**
 * PUT /api/connections/settings — one connection's configuration.
 *
 * A separate path from `/api/connections` because these writes are a different
 * kind of act: granting is a consent decision, and this is configuration. They
 * are audited apart for the same reason — "which value changed" and "what did
 * the user allow" are different questions.
 */

import { putConnectionSettings } from "@/lib/plugins/endpoint";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(request: Request) {
  return putConnectionSettings(request);
}
