// Marketr — CRM pipelines: per-client pipelines (agency white-label fit).
// GET  /api/crm/pipelines  → pipelines + active lead counts
// POST /api/crm/pipelines  → create { name, stages?, clientId? } (editor+)

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { DEFAULT_STAGES, parseStages, validateStageSet } from "@/lib/crm/stages";
import { getActiveLeadCountByPipeline } from "@/lib/crm/meter";

const StageSchema = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[a-z0-9_-]+$/i),
  label: z.string().trim().min(1).max(60),
  color: z.enum(["violet", "blue", "teal", "amber", "green", "gray", "red"]).default("gray"),
});

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  stages: z.array(StageSchema).min(2).max(20).optional(),
  clientId: z.string().trim().min(1).max(64).optional(),
});

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const pipelines = await prisma.pipeline.findMany({
    where: { workspaceId: workspace.id },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    include: { client: { select: { id: true, name: true } } },
  });
  const activeByPipeline = await getActiveLeadCountByPipeline(workspace.id);
  return Response.json({
    pipelines: pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      stages: p.stages,
      isDefault: p.isDefault,
      client: p.client,
      activeLeads: activeByPipeline[p.id] ?? 0,
    })),
  });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const stages = parsed.data.stages ?? DEFAULT_STAGES;
  // Must contain the canonical closed stages so the meter/forecast agree.
  try {
    validateStageSet(stages);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Invalid stages" }, { status: 400 });
  }

  if (parsed.data.clientId) {
    const client = await prisma.client.findFirst({
      where: { id: parsed.data.clientId, workspaceId: workspace.id },
    });
    if (!client) return Response.json({ error: "Client not found" }, { status: 404 });
  }

  const existing = await prisma.pipeline.count({ where: { workspaceId: workspace.id } });
  const pipeline = await prisma.pipeline.create({
    data: {
      workspaceId: workspace.id,
      name: parsed.data.name,
      stages: stages as unknown as Prisma.InputJsonValue,
      clientId: parsed.data.clientId ?? null,
      isDefault: existing === 0,
    },
  });
  return Response.json({ pipeline }, { status: 201 });
}
