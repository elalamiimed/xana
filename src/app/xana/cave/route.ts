/**
 * POST /api/cave is the app's prefix; /xana/cave is the canonical one.
 * Same handlers, matching how context and settings are exposed.
 */

import { GET as getCave, POST as postCave } from "@/app/api/cave/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return getCave(request);
}

export async function POST(request: Request) {
  return postCave(request);
}
