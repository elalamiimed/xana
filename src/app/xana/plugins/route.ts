/**
 * GET/POST /xana/plugins — the pre-rename address of the connection surface.
 *
 * Re-exports the canonical `/xana/connections` handlers, so an older client
 * keeps working and cannot drift from the current behaviour.
 */

export { GET, POST } from "@/app/xana/connections/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
