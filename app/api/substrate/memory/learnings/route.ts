// Marketr — /api/substrate/memory/learnings (Phase 8 G3).
// GET: list learnings (filters: result, source, since, q) — current rows only
//      by default; invalidated rows available with includeInvalidated=1.
// POST (editor): human-asserted learning → confidence 1.0, origin user_told.

import type { NextRequest } from "next/server";
import { memoryGuard, badRequest, readJson, memoryAudit } from "../_lib";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { recordLearning } from "@/lib/substrate/memory/write";

export const dynamic = "force-dynamic";

const RESULTS = ["worked", "failed", "inconclusive"] as const;

export async function GET(req: NextRequest) {
  const gate = await memoryGuard(req, "viewer");
  if (gate instanceof Response) return gate;
  const p = req.nextUrl.searchParams;
  const result = p.get("result");
  const source = p.get("source");
  const since = p.get("since");
  const q = p.get("q")?.trim() ?? "";
  const includeInvalidated = p.get("includeInvalidated") === "1";
  const limit = Math.min(Number(p.get("limit") ?? 50) || 50, 200);
  if (result && !(RESULTS as readonly string[]).includes(result)) {
    return badRequest(`unknown result: ${result}`);
  }

  const rows = await withWorkspaceScope(gate.workspaceId, (tx) =>
    tx.memoryLearning.findMany({
      where: {
        workspaceId: gate.workspaceId,
        ...(result ? { result: result as (typeof RESULTS)[number] } : {}),
        ...(source ? { source: source as never } : {}),
        ...(since ? { observedAt: { gte: new Date(since) } } : {}),
        ...(includeInvalidated ? {} : { invalidatedAt: null }),
        ...(q
          ? {
              OR: [
                { hypothesis: { contains: q, mode: "insensitive" } },
                { action: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { observedAt: "desc" },
      take: limit,
      select: {
        id: true,
        hypothesis: true,
        action: true,
        result: true,
        observedAt: true,
        source: true,
        sourceEpisodeId: true,
        invalidatedAt: true,
        contextRefs: true,
      },
    }),
  );
  return Response.json({ learnings: rows });
}

export async function POST(req: NextRequest) {
  const gate = await memoryGuard(req, "editor");
  if (gate instanceof Response) return gate;
  const body = await readJson(req);
  const hypothesis = String(body.hypothesis ?? "").trim();
  const action = String(body.action ?? "").trim();
  const result = String(body.result ?? "");
  if (!hypothesis) return badRequest("hypothesis is required");
  if (!action) return badRequest("action is required");
  if (!(RESULTS as readonly string[]).includes(result)) {
    return badRequest(`result must be one of ${RESULTS.join(", ")}`);
  }
  const observedAt = body.observedAt ? new Date(String(body.observedAt)) : undefined;
  if (observedAt && Number.isNaN(observedAt.getTime())) return badRequest("observedAt must be an ISO timestamp");

  const created = await recordLearning(gate.workspaceId, {
    hypothesis,
    action,
    result: result as (typeof RESULTS)[number],
    source: "human",
    observedAt,
    // Human-asserted learnings are user-told facts: decay-to-floor keeps them
    // (pruneToFloor honors contextRefs.origin = "user_told").
    contextRefs: { ...((body.contextRefs ?? {}) as Record<string, unknown>), origin: "user_told" },
  });
  memoryAudit().log(gate.workspaceId, gate.userId, "learning.created", created.id, { result });
  return Response.json({ learning: { id: created.id }, redactions: created.redactions }, { status: 201 });
}
