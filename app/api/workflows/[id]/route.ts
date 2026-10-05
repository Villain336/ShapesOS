// Marketr — automation canvas API: single workflow.
// GET    /api/workflows/[id]          (viewer+)
// PATCH  /api/workflows/[id]          { name?, description?, status?, schedule?, enabled? } (editor+)
// DELETE /api/workflows/[id]          (editor+)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isError, requireWorkflow } from "@/lib/workflow/http";
import { parseCron, parseTimeZone } from "@/lib/workflow/cron";

export const dynamic = "force-dynamic";

const STATUSES = ["draft", "active", "paused", "archived"] as const;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireWorkflow(user.id, id, "viewer");
  if (isError(access)) return access.error;

  const workflow = await prisma.workflow.findUniqueOrThrow({
    where: { id: access.workflow.id },
    include: { nodes: true, edges: true },
  });
  return Response.json({ workflow });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireWorkflow(user.id, id, "editor");
  if (isError(access)) return access.error;

  let body: {
    name?: string;
    description?: string | null;
    status?: string;
    schedule?: string | null;
    /** IANA timezone the schedule is read in (default UTC). */
    timezone?: string | null;
    enabled?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return Response.json({ error: "name cannot be empty" }, { status: 400 });
    data.name = name.slice(0, 120);
  }
  if (body.description !== undefined) {
    data.description = (body.description ?? "").trim().slice(0, 500) || null;
  }
  if (body.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(body.status)) {
      return Response.json({ error: `status must be one of: ${STATUSES.join(", ")}` }, { status: 400 });
    }
    data.status = body.status;
  }
  if (body.schedule !== undefined) {
    const schedule = (body.schedule ?? "").trim();
    if (schedule) {
      try {
        parseCron(schedule);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Invalid cron" }, { status: 400 });
      }
      data.schedule = schedule;
    } else {
      data.schedule = null;
    }
  }
  if (body.timezone !== undefined) {
    try {
      data.timezone = parseTimeZone(typeof body.timezone === "string" ? body.timezone.trim() : body.timezone);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Invalid timezone" }, { status: 400 });
    }
  }
  if (body.enabled !== undefined) data.enabled = !!body.enabled;

  const workflow = await prisma.workflow.update({ where: { id: access.workflow.id }, data: data as never });
  return Response.json({ workflow });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireWorkflow(user.id, id, "editor");
  if (isError(access)) return access.error;

  await prisma.workflow.delete({ where: { id: access.workflow.id } });
  await prisma.fileChangeLog.create({
    data: {
      workspaceId: access.project.workspaceId,
      projectId: access.project.id,
      connectionId: null,
      filePath: "",
      actor: "user",
      action: "save",
      summary: `Workflow deleted: ${access.workflow.id}`.slice(0, 280),
    },
  });
  return Response.json({ ok: true });
}
