// Marketr — GET /api/automation/pending (Phase 9 M6).
//
// The approvals inbox feed: pending MissionApproval rows across all
// missions for this workspace, newest first. Powers
// app/dashboard/approvals/page.tsx.

import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { automationGuard } from "../_lib";

export const dynamic = "force-dynamic";

/** Compact one-line payload summary from the canonicalized binding JSON. */
function payloadSummary(bindingJson: unknown): string {
  if (!bindingJson || typeof bindingJson !== "object") return "";
  const entries = Object.entries(bindingJson as Record<string, unknown>);
  const parts = entries.slice(0, 4).map(([k, v]) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}: ${s && s.length > 60 ? `${s.slice(0, 60)}…` : s}`;
  });
  return parts.join(" · ");
}

function bindingAmountCents(bindingJson: unknown): number | null {
  if (!bindingJson || typeof bindingJson !== "object") return null;
  const v = (bindingJson as Record<string, unknown>).amountCents;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function GET() {
  const access = await automationGuard("viewer");
  if (access instanceof Response) return access;

  const rows = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.missionApproval.findMany({
      where: { workspaceId: access.workspaceId, status: "pending" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        missionId: true,
        action: true,
        tier: true,
        bindingJson: true,
        bindingHash: true,
        createdBy: true,
        createdAt: true,
        expiresAt: true,
        mission: { select: { id: true, template: true } },
      },
    }),
  );

  return Response.json({
    approvals: rows.map((r) => ({
      id: r.id,
      missionId: r.missionId,
      missionTemplate: r.mission?.template ?? null,
      action: r.action,
      tier: r.tier,
      amountCents: bindingAmountCents(r.bindingJson),
      payloadSummary: payloadSummary(r.bindingJson),
      bindingHash: r.bindingHash,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    })),
  });
}
