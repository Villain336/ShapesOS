// ShapesOS — Phase 21B (WS=drive): the folders a person gives an agent run (its grant, besides the
// run's own /agents/<runId> workspace). The run can read and save inside them, under the tiers in
// lib/drive/tools.ts; it never has more access than the person who started it.
// GET    /api/drive/runs/[runId]/folders?workspaceId=            (viewer+) → { folders }
// POST   /api/drive/runs/[runId]/folders { workspaceId, folder } (editor+; the starter or an admin) → { folders }
// DELETE /api/drive/runs/[runId]/folders?workspaceId=&folder=    (editor+; the starter or an admin) → { folders }

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { filesErrorResponse } from "@/lib/files/http";
import { attachFolderToRun, detachFolderFromRun, loadGrant } from "@/lib/drive/run-folders";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ runId: string }> };
const RunId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await ctx.params;
  if (!RunId.safeParse(runId).success) return badRequest("Unknown run.");
  const access = await requireWorkspaceAccess(user.id, req.nextUrl.searchParams.get("workspaceId"), "viewer");
  if ("error" in access) return access.error;
  const grant = await loadGrant(access.workspaceId, runId, user.id);
  return Response.json({ runFolder: `/agents/${grant.runId}`, folders: grant.folders });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await ctx.params;
  const parsed = z.object({ workspaceId: z.string().min(1).max(120), folder: z.string().min(1).max(1100) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success || !RunId.safeParse(runId).success) return badRequest("Invalid request.");
  const access = await requireWorkspaceAccess(user.id, parsed.data.workspaceId, "editor");
  if ("error" in access) return access.error;
  try {
    return Response.json(await attachFolderToRun({ workspaceId: access.workspaceId, userId: user.id, role: access.membership.role }, runId, parsed.data.folder));
  } catch (err) {
    return filesErrorResponse(err, "drive run folders");
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await ctx.params;
  const qs = req.nextUrl.searchParams;
  const access = await requireWorkspaceAccess(user.id, qs.get("workspaceId"), "editor");
  if ("error" in access) return access.error;
  const folder = qs.get("folder") ?? "";
  if (!folder || !RunId.safeParse(runId).success) return badRequest("Invalid request.");
  try {
    return Response.json(await detachFolderFromRun({ workspaceId: access.workspaceId, userId: user.id, role: access.membership.role }, runId, folder));
  } catch (err) {
    return filesErrorResponse(err, "drive run folders");
  }
}
