// Marketr — GET /api/intelligence/community/opportunities (Phase 10 M8).
//
// The opportunity queue: pending community drafts in the Phase 9 approval
// inbox (mission_approvals action "community_reply_draft"). Drafts
// themselves live in the inbox — this feed is the read model for the
// Community page's queue tab.

import { withWorkspaceScope, type TxClient } from "@/lib/substrate/graph/rls";
import { COMMUNITY_DRAFT_ACTION } from "@/lib/intelligence/community";
import { intelligenceGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await intelligenceGuard("viewer");
  if (access instanceof Response) return access;

  const rows = await withWorkspaceScope(access.workspaceId, (tx: TxClient) =>
    tx.missionApproval.findMany({
      where: {
        workspaceId: access.workspaceId,
        action: COMMUNITY_DRAFT_ACTION,
        status: "pending",
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        tier: true,
        bindingJson: true,
        bindingHash: true,
        createdBy: true,
        createdAt: true,
        expiresAt: true,
      },
    }),
  );

  return Response.json({
    opportunities: rows.map((r) => {
      const b = (r.bindingJson ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string => (typeof v === "string" ? v : "");
      const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
      return {
        id: r.id,
        tier: r.tier,
        source: str(b.source),
        thread: str(b.thread),
        threadUrl: str(b.threadUrl),
        reason: str(b.reason),
        draft: str(b.draft),
        signals: str(b.signal),
        matchedKeywords: arr(b.matchedKeywords),
        feedName: typeof b.feedName === "string" ? b.feedName : null,
        author: typeof b.author === "string" ? b.author : null,
        bindingHash: r.bindingHash,
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      };
    }),
  });
}
