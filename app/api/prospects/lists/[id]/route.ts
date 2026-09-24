// Marketr — R6 single list API.
// GET    /api/prospects/lists/[id] → list detail + status stats
// PATCH  /api/prospects/lists/[id] (editor) → { name?, icp?, status? }
// DELETE /api/prospects/lists/[id] (editor) → delete list + prospects

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { auditEvent } from "@/lib/auditlog";
import type { FileChangeAction } from "@prisma/client";
import { guardWorkspace, httpErrorResponse, readJson, HttpError } from "@/lib/enrichment/guard";

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  icp: z
    .object({
      industries: z.array(z.string().max(80)).max(50).optional(),
      employeeRange: z.string().max(40).nullable().optional(),
      geo: z.string().max(120).nullable().optional(),
      techSignals: z.array(z.string().max(80)).max(50).optional(),
      titles: z.array(z.string().max(80)).max(50).optional(),
    })
    .optional(),
  status: z.enum(["draft", "building", "ready", "archived"]).optional(),
});

async function getList(workspaceId: string, id: string) {
  const list = await prisma.prospectList.findFirst({
    where: { id, workspaceId },
  });
  if (!list) throw new HttpError(404, "List not found");
  return list;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    const list = await getList(workspace.id, id);
    const byStatus = await prisma.prospect.groupBy({
      by: ["status"],
      where: { workspaceId: workspace.id, listId: id },
      _count: { id: true },
    });
    return Response.json({
      list,
      stats: Object.fromEntries(byStatus.map((r) => [r.status, r._count.id])),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    await getList(workspace.id, id);
    const parsed = PatchSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.status !== undefined) data.status = parsed.data.status;
    if (parsed.data.icp !== undefined) {
      const current = ((await getList(workspace.id, id)).icp ?? {}) as Record<string, unknown>;
      data.icp = { ...current, ...parsed.data.icp };
    }
    const list = await prisma.prospectList.update({ where: { id }, data });
    await auditEvent({
      projectId: null,
      workspaceId: workspace.id,
      action: "prospect_list_updated" as FileChangeAction,
      summary: `Prospect list "${list.name}" updated`,
      actorUserId: user.id,
    }).catch(() => {});
    return Response.json({ list });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const list = await getList(workspace.id, id);
    await prisma.prospectList.delete({ where: { id } });
    await auditEvent({
      projectId: null,
      workspaceId: workspace.id,
      action: "prospect_list_deleted" as FileChangeAction,
      summary: `Prospect list "${list.name}" deleted (${id})`,
      actorUserId: user.id,
    }).catch(() => {});
    return Response.json({ ok: true });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
