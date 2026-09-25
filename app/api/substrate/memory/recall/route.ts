// Marketr — POST /api/substrate/memory/recall (Phase 8 G3).
// memory_recall(): hybrid lexical+vector → fusion → cross-encoder rerank →
// MMR + recency. Provenance + freshness on every hit.

import type { NextRequest } from "next/server";
import { memoryGuard, badRequest, readJson } from "../_lib";
import { memoryRecall } from "@/lib/substrate/memory/recall";
import { freshnessLabel } from "@/lib/substrate/graph/freshness";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await memoryGuard(req, "viewer");
  if (gate instanceof Response) return gate;
  const body = await readJson(req);
  const query = String(body.query ?? "").trim();
  if (!query) return badRequest("query is required");
  const topK = Math.min(Math.max(Number(body.topK ?? 10) || 10, 1), 50);
  let asOf: Date | undefined;
  if (body.asOf) {
    asOf = new Date(String(body.asOf));
    if (Number.isNaN(asOf.getTime())) return badRequest("asOf must be an ISO timestamp");
  }
  const alpha = body.alpha == null ? undefined : Number(body.alpha);
  if (alpha != null && !(alpha >= 0 && alpha <= 1)) return badRequest("alpha must be in [0,1]");

  const hits = await memoryRecall(gate.workspaceId, {
    query,
    topK,
    asOf,
    alpha,
    skipRerank: body.skipRerank === true,
  });
  const now = new Date();
  return Response.json({
    query,
    hits: hits.map((h) => ({
      ...h,
      observedAt: h.observedAt.toISOString(),
      validFrom: h.validFrom?.toISOString() ?? null,
      validTo: h.validTo?.toISOString() ?? null,
      freshness: freshnessLabel(h.observedAt, `memory:${h.store}`, now),
    })),
  });
}
