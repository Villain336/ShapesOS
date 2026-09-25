// Marketr — POST /api/substrate/context (Phase 8 G3).
// substrate.context(): one bounded call — ranked graph slice + recalled
// memories with provenance and freshness labels. The Phase 9 orchestrator
// interface.

import type { NextRequest } from "next/server";
import { memoryGuard, badRequest, readJson } from "../memory/_lib";
import { substrateContext } from "@/lib/substrate/context";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await memoryGuard(req, "viewer");
  if (gate instanceof Response) return gate;
  const body = await readJson(req);
  const query = String(body.query ?? "").trim();
  if (!query) return badRequest("query is required");
  let asOf: Date | undefined;
  if (body.asOf) {
    asOf = new Date(String(body.asOf));
    if (Number.isNaN(asOf.getTime())) return badRequest("asOf must be an ISO timestamp");
  }
  const ctx = await substrateContext(gate.workspaceId, {
    query,
    topK: body.topK != null ? Number(body.topK) : undefined,
    graphLimit: body.graphLimit != null ? Number(body.graphLimit) : undefined,
    asOf,
    alpha: body.alpha != null ? Number(body.alpha) : undefined,
    skipRerank: body.skipRerank === true,
  });
  return Response.json(ctx);
}
