// Marketr — CRM pipeline detail.
// GET    /api/crm/pipelines/[id]  → pipeline + stages + counts
// PATCH  /api/crm/pipelines/[id]  → rename / restage (editor+; stage ids
//          referenced by leads cannot be removed)
// DELETE /api/crm/pipelines/[id]  → removes pipeline + leads + forms (admin+)

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { parseStages, validateStageSet } from "@/lib/crm/stages";

const StageSchema = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[a-z0-9_-]+$/i),
  label: z.string().trim().min(1).max(60),
  color: z.enum(["violet", "blue", "teal", "amber", "green", "gray", "red"]).default("gray"),
});

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  stages: z.array(StageSchema).min(2).max(20).optional(),
}).refine((d) => d.name !== undefined || d.stages !== undefined, {
  message: "Nothing to update",
});

async function getPipeline(workspaceId: string, id: string) {
  return prisma.pipeline.findFirst({
    where: { id, workspaceId },
    include: { client: { select: { id: true, name: true } } },
  });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { id } = await ctx.params;
  const pipeline = await getPipeline(workspace.id, id);
  if (!pipeline) return Response.json({ error: "Not found" }, { status: 404 });
  const byStage = await prisma.lead.groupBy({
    by: ["stage"],
    where: { workspaceId: workspace.id, pipelineId: id },
    _count: { _all: true },
  });
  return Response.json({
    pipeline,
    leadCounts: Object.fromEntries(byStage.map((r) => [r.stage, r._count._all])),
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await ctx.params;
  const pipeline = await getPipeline(workspace.id, id);
  if (!pipeline) return Response.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  if (parsed.data.stages) {
    const stages = parseStages(parsed.data.stages);
    try {
      validateStageSet(stages);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "Invalid stages" }, { status: 400 });
    }
    // Stage ids in use by leads cannot be removed (no orphan stages).
    const inUse = await prisma.lead.findMany({
      where: { workspaceId: workspace.id, pipelineId: id },
      select: { stage: true },
      distinct: ["stage"],
    });
    const nextIds = new Set(stages.map((s) => s.id));
    const removed = inUse.map((l) => l.stage).filter((s) => !nextIds.has(s));
    if (removed.length > 0) {
      return Response.json(
        { error: `Stage(s) in use cannot be removed: ${removed.join(", ")}` },
        { status: 409 },
      );
    }
    const updated = await prisma.pipeline.update({
      where: { id },
      data: { stages: stages as unknown as Prisma.InputJsonValue, ...(parsed.data.name ? { name: parsed.data.name } : {}) },
    });
    return Response.json({ pipeline: updated });
  }

  const updated = await prisma.pipeline.update({ where: { id }, data: { name: parsed.data.name } });
  return Response.json({ pipeline: updated });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return forbidden();
  const { id } = await ctx.params;
  const pipeline = await getPipeline(workspace.id, id);
  if (!pipeline) return Response.json({ error: "Not found" }, { status: 404 });
  // Cascades to leads → activities, and capture forms (Prisma relations).
  await prisma.pipeline.delete({ where: { id } });
  return Response.json({ deleted: id });
}
