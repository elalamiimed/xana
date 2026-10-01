/**
 * GET /api/plugins — the pre-rename address of the connection surface.
 *
 * Kept because the name was public: a script, a bookmark, or a client bundle
 * built before the rename points here. It re-exports the canonical handlers
 * rather than reimplementing them, so there is exactly one behaviour and the
 * two paths cannot disagree.
 *
 * `POST` accepts the same `{ id, action }` body as before.
 */

export { GET, POST } from "@/app/api/connections/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
