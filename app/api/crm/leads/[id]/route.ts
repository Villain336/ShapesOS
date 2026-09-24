// Marketr — CRM lead detail.
// GET    /api/crm/leads/[id]  → lead + pipeline stages + recent activities
// PATCH  /api/crm/leads/[id]  → update fields (editor+); stage changes are
//          validated against the pipeline's stage machine and logged
// DELETE /api/crm/leads/[id]  → delete (editor+)

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { parseStages } from "@/lib/crm/stages";
import { scoreFor } from "@/lib/crm/stages";
import { maybeRecordWonRevenue } from "@/lib/attribution/revenue";
import { dedupKeyFor, recomputeScore, logActivity } from "@/lib/crm/dedup";

const SOURCES = ["website_form", "phone", "referral", "import", "ad", "ooh", "direct_mail", "other"] as const;

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  company: z.string().trim().max(160).nullable().optional(),
  title: z.string().trim().max(160).nullable().optional(),
  source: z.enum(SOURCES).optional(),
  sourceDetail: z.string().trim().max(240).nullable().optional(),
  stage: z.string().trim().min(1).max(40).optional(),
  valueCents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  ownerId: z.string().max(128).nullable().optional(),
  ownerName: z.string().trim().max(160).nullable().optional(),
  projectId: z.string().max(64).nullable().optional(),
  starred: z.boolean().optional(),
  customFields: z.record(z.string(), z.unknown()).nullable().optional(),
}).refine((d) => Object.values(d).some((v) => v !== undefined), {
  message: "Nothing to update",
});

async function getLead(workspaceId: string, id: string) {
  return prisma.lead.findFirst({
    where: { id, workspaceId },
    include: { pipeline: true },
  });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { id } = await ctx.params;
  const lead = await getLead(workspace.id, id);
  if (!lead) return Response.json({ error: "Not found" }, { status: 404 });

  const activities = await prisma.leadActivity.findMany({
    where: { leadId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const stages = parseStages(lead.pipeline.stages);
  const engagement = activities.filter((a) =>
    ["note", "email", "call", "sms", "meeting", "form_submit"].includes(a.type),
  ).length;
  const scoreBreakdown = scoreFor({
    source: lead.source,
    email: lead.email,
    phone: lead.phone,
    company: lead.company,
    lastActivityAt: lead.lastActivityAt,
    engagementCount: engagement,
  });
  return Response.json({ lead, stages, activities, scoreBreakdown });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await ctx.params;
  const lead = await getLead(workspace.id, id);
  if (!lead) return Response.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;

  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) {
    return Response.json({ error: "Invalid email" }, { status: 400 });
  }
  if (d.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: d.projectId, workspaceId: workspace.id },
    });
    if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  }

  // Stage machine validation: the new stage must exist in the pipeline.
  const stages = parseStages(lead.pipeline.stages);
  if (d.stage && !stages.some((s) => s.id === d.stage)) {
    return Response.json({ error: `Unknown stage "${d.stage}" for this pipeline` }, { status: 400 });
  }

  const stageChanged = d.stage !== undefined && d.stage !== lead.stage;

  // Recompute dedup identity when contact fields change.
  const contactChanged =
    d.email !== undefined || d.phone !== undefined;
  let dedupKey = lead.dedupKey;
  if (contactChanged) {
    dedupKey = dedupKeyFor(
      d.email !== undefined ? d.email : lead.email,
      d.phone !== undefined ? d.phone : lead.phone,
    );
    if (dedupKey && dedupKey !== lead.dedupKey) {
      const clash = await prisma.lead.findFirst({
        where: { workspaceId: workspace.id, dedupKey, id: { not: lead.id } },
        select: { id: true, name: true },
      });
      if (clash) {
        return Response.json(
          { error: "Another lead already uses this email/phone", duplicate: true, existing: clash },
          { status: 409 },
        );
      }
    }
  }

  const data: Prisma.LeadUpdateInput = {
    ...(d.name !== undefined ? { name: d.name } : {}),
    ...(d.email !== undefined ? { email: d.email?.trim() || null } : {}),
    ...(d.phone !== undefined ? { phone: d.phone?.trim() || null } : {}),
    ...(d.company !== undefined ? { company: d.company?.trim() || null } : {}),
    ...(d.title !== undefined ? { title: d.title?.trim() || null } : {}),
    ...(d.source !== undefined ? { source: d.source } : {}),
    ...(d.sourceDetail !== undefined ? { sourceDetail: d.sourceDetail?.trim() || null } : {}),
    ...(d.stage !== undefined ? { stage: d.stage } : {}),
    ...(d.valueCents !== undefined ? { valueCents: d.valueCents } : {}),
    ...(d.ownerId !== undefined ? { ownerId: d.ownerId } : {}),
    ...(d.ownerName !== undefined ? { ownerName: d.ownerName?.trim() || null } : {}),
    ...(d.projectId !== undefined ? { projectId: d.projectId } : {}),
    ...(d.starred !== undefined ? { starred: d.starred } : {}),
    ...(d.customFields !== undefined
      ? { customFields: d.customFields as unknown as Prisma.InputJsonValue }
      : {}),
    ...(contactChanged ? { dedupKey } : {}),
  };
  const updated = await prisma.lead.update({ where: { id: lead.id }, data });

  const actor = user.name ?? user.email ?? "User";
  if (stageChanged) {
    const from = stages.find((s) => s.id === lead.stage)?.label ?? lead.stage;
    const to = stages.find((s) => s.id === d.stage)?.label ?? d.stage;
    await logActivity({
      workspaceId: workspace.id,
      leadId: lead.id,
      type: "stage_change",
      body: `Stage: ${from} → ${to}`,
      actor,
    });
  }
  // C2: a lead newly reaching won with a value books a revenue event.
  if (d.stage !== undefined || d.valueCents !== undefined) {
    await maybeRecordWonRevenue({
      workspaceId: workspace.id,
      leadId: lead.id,
      before: { stage: lead.stage, valueCents: lead.valueCents },
      after: { stage: d.stage ?? lead.stage, valueCents: updated.valueCents },
      actor,
    });
  }
  if (contactChanged || stageChanged || d.source !== undefined) {
    await recomputeScore(lead.id, workspace.id);
  }

  const full = await prisma.lead.findUnique({ where: { id: lead.id } });
  return Response.json({ lead: full ?? updated });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await ctx.params;
  const lead = await getLead(workspace.id, id);
  if (!lead) return Response.json({ error: "Not found" }, { status: 404 });
  await prisma.lead.delete({ where: { id } }); // cascades activities
  return Response.json({ deleted: id });
}
