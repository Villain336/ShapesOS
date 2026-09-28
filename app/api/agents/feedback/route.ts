// Marketr — POST /api/agents/feedback (Phase 13B, worker 5; enhanced by worker 2).
// Explicit feedback signals from UI affordances (thumbs up/down on agent
// outputs). Contract: AgentFeedback { episodeId?, agentId, kind, signal }.
// kind here is explicit_up | explicit_down; signal = { source: "ui" } and
// is secret-scrubbed before write (DATA-MODEL rule 5).
//
// Worker-2 additions: learning-paused respect (pref:learning_paused skips
// the write with a calm reason code instead of an error), episodeId
// workspace-ownership validation (404 on foreign/missing episodes).

import type { NextRequest } from "next/server";
import { agentsGuard, badRequest, readJson } from "../_lib";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getLearningPaused } from "@/lib/substrate/memory/preferences";
import { scrubJson } from "@/lib/substrate/memory/scrub";

export const dynamic = "force-dynamic";

const EXPLICIT_KINDS = ["explicit_up", "explicit_down"] as const;

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const gate = await agentsGuard(req, "editor", body);
  if (gate instanceof Response) return gate;

  const agentId = String(body.agentId ?? "business-strategist").slice(0, 120);
  const kind = String(body.kind ?? "");
  if (!(EXPLICIT_KINDS as readonly string[]).includes(kind)) {
    return badRequest(`kind must be one of ${EXPLICIT_KINDS.join(", ")}`);
  }
  const episodeId =
    typeof body.episodeId === "string" && body.episodeId.trim()
      ? body.episodeId.trim()
      : null;
  // Nullable: feedback can attach to a non-episode artifact (e.g. a
  // command-bar answer with no persisted episode yet).
  const signal = scrubJson({ source: "ui", kind });

  const gate2 = await withWorkspaceScope(gate.workspaceId, async (tx) => {
    // Learning paused → record nothing (fail-calm, not an error: the UI
    // should not toast an error for an intentional user setting).
    if (await getLearningPaused(tx, gate.workspaceId)) return "paused" as const;
    // An episode id must belong to this workspace — no cross-workspace
    // signal attachment.
    if (episodeId) {
      const ep = await tx.memoryEpisode.findFirst({
        where: { id: episodeId, workspaceId: gate.workspaceId },
        select: { id: true },
      });
      if (!ep) return "bad_episode" as const;
    }
    const created = await tx.agentFeedback.create({
      data: {
        workspaceId: gate.workspaceId,
        episodeId,
        agentId,
        kind: kind as (typeof EXPLICIT_KINDS)[number],
        signal: signal.value as object,
      },
      select: { id: true, kind: true, agentId: true, createdAt: true },
    });
    return created;
  });

  if (gate2 === "paused") {
    return Response.json({ feedback: null, recorded: false, reason: "learning_paused" });
  }
  if (gate2 === "bad_episode") {
    return Response.json({ error: "Episode not found in workspace." }, { status: 404 });
  }
  return Response.json({ feedback: gate2, redactions: signal.redactions });
}

/** GET: recent feedback (viewer) — newest first, limit 200. Supports agentId + kind filters. */
export async function GET(req: NextRequest) {
  const gate = await agentsGuard(req, "viewer");
  if (gate instanceof Response) return gate;
  const p = req.nextUrl.searchParams;
  const agentId = p.get("agentId")?.trim() || undefined;
  const kind = p.get("kind")?.trim() || undefined;
  const limit = Math.min(Number(p.get("limit") ?? 50) || 50, 200);

  const rows = await withWorkspaceScope(gate.workspaceId, (tx) =>
    tx.agentFeedback.findMany({
      where: {
        workspaceId: gate.workspaceId,
        ...(agentId ? { agentId } : {}),
        ...(kind ? { kind: kind as (typeof EXPLICIT_KINDS)[number] } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        agentId: true,
        kind: true,
        episodeId: true,
        signal: true,
        createdAt: true,
      },
    }),
  );
  return Response.json({
    feedback: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  });
}
