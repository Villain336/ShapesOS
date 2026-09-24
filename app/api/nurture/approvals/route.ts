// Marketr — R3 approval queue API (human gate for outbound sends).
// GET /api/nurture/approvals?status=pending&kind=sequence_send
//
// ApprovalItems are created by the nurture engine (kind "sequence_send") and
// the speed-to-lead flow. The messaging dispatcher only releases messages
// whose approval is "approved" — this queue is the human side of that gate.

import { prisma } from "@/lib/prisma";
import { nurtureCtx } from "../_lib";

export const dynamic = "force-dynamic";

const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;

export async function GET(req: Request) {
  const ctx = await nurtureCtx();
  if (ctx instanceof Response) return ctx;
  const sp = new URL(req.url).searchParams;

  const where: Record<string, unknown> = { workspaceId: ctx.workspaceId };
  const status = sp.get("status");
  if (status && (APPROVAL_STATUSES as readonly string[]).includes(status)) where.status = status;
  else where.status = "pending";
  const kind = sp.get("kind")?.trim();
  if (kind) where.kind = kind;

  const limit = Math.min(200, Math.max(1, Number(sp.get("limit") ?? "100") || 100));

  const [items, total] = await Promise.all([
    prisma.approvalItem.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.approvalItem.count({ where: where as never }),
  ]);

  // Resolve lead names for preview (payloads carry leadId for sequence sends).
  const leadIds = [...new Set(items.map((i) => (i.payload as Record<string, unknown>)?.leadId).filter((v): v is string => typeof v === "string"))];
  const leads = leadIds.length
    ? await prisma.lead.findMany({
        where: { workspaceId: ctx.workspaceId, id: { in: leadIds } },
        select: { id: true, name: true, company: true },
      })
    : [];
  const leadById = new Map(leads.map((l) => [l.id, l]));

  return Response.json({
    items: items.map((i) => {
      const payload = (i.payload ?? {}) as Record<string, unknown>;
      const leadId = typeof payload.leadId === "string" ? payload.leadId : null;
      return { ...i, lead: leadId ? leadById.get(leadId) ?? null : null };
    }),
    total,
  });
}
