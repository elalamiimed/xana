/**
 * PUT /api/plugins/settings — the pre-rename address of connection settings.
 *
 * Re-exports the canonical handler; see `/api/connections/settings`.
 */

export { PUT } from "@/app/api/connections/settings/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
