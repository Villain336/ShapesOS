// ShapesOS — GET /api/status: the public status page's data (beta readiness,
// WS=legal). PUBLIC BY DESIGN (scripts/verify-m11-security.mjs lists it):
// read-only, no session, and the body carries component states, operator
// notes, incident titles and timelines only — never operator ids, workspace
// ids, hostnames or error text (lib/status/public.ts, lib/status/store.ts
// toPublic). Cached: 15 s in-process and 30 s at the edge.

import { CACHE_SECONDS, statusSnapshot } from "@/lib/status/public";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const snapshot = await statusSnapshot();
  return Response.json(snapshot, {
    headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}, s-maxage=30, stale-while-revalidate=60` },
  });
}
