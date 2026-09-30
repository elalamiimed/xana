/**
 * PUT /api/plugins/settings — one plugin's configuration.
 *
 * A separate path from `/api/plugins` because these writes are a different
 * kind of decision: a grant says what Xana may do, a setting says where. They
 * fail differently too — a bad grant is a rejected permission, a bad setting is
 * a key no plugin declared.
 */

import { putPluginSettings } from "@/lib/plugins/endpoint";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(request: Request) {
  return putPluginSettings(request);
}
