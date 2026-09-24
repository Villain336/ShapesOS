// Marketr — Attribution API: touch timeline for one lead.
// GET /api/attribution/timeline?leadId=
// Ordered touch sequence with each touch's revenue credit under all three
// models. Tenant-scoped: the lead must belong to the caller's workspace.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { leadRevenueCents } from "@/lib/attribution/revenue";
import { creditByModel, type ModelTouch } from "@/lib/attribution/models";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const leadId = new URL(req.url).searchParams.get("leadId");
  if (!leadId) return Response.json({ error: "leadId required" }, { status: 400 });

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, workspaceId: workspace.id },
    select: { id: true, name: true, company: true, stage: true, valueCents: true },
  });
  if (!lead) return Response.json({ error: "Lead not found" }, { status: 404 });

  const touches = await prisma.attributionTouch.findMany({
    where: { leadId, workspaceId: workspace.id },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: 1000,
  });

  const revenue = leadRevenueCents(lead);
  const modelTouches: ModelTouch[] = touches.map((t) => ({
    id: t.id,
    leadId: t.leadId,
    channel: t.channel,
    campaign: t.campaign,
    contentId: t.contentId,
    occurredAt: t.occurredAt,
  }));
  const credit = creditByModel(modelTouches, revenue);

  return Response.json({
    lead: { id: lead.id, name: lead.name, company: lead.company, stage: lead.stage, revenueCents: revenue },
    touches: touches.map((t, i) => ({
      id: t.id,
      channel: t.channel,
      source: t.source,
      medium: t.medium,
      campaign: t.campaign,
      contentId: t.contentId,
      touchType: t.touchType,
      occurredAt: t.occurredAt,
      creditCents: {
        first_touch: credit.first_touch[i],
        last_touch: credit.last_touch[i],
        linear: credit.linear[i],
      },
    })),
  });
}
