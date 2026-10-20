// ShapesOS — Phase 18.2 (WS=content): one PDF annotation.
// PATCH  …/annotations/[annotationId] { workspaceId, body } → { annotation }
// DELETE …/annotations/[annotationId]?workspaceId=          → { ok: true }
// Access: requireWorkspaceAccess (editor+) + its author or the file's owner.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { removeAnnotation, updateAnnotation } from "@/lib/files/annotations";
import { fileActor, filesErrorResponse } from "@/lib/files/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ fileId: string; annotationId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId, annotationId } = await ctx.params;
  const body = z.object({ workspaceId: z.string().min(1).max(120), body: z.string().max(10_000).nullable() }).safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest("Invalid annotation change.");
  const access = await requireWorkspaceAccess(user.id, body.data.workspaceId, "editor");
  if ("error" in access) return access.error;
  try {
    return Response.json({ annotation: await updateAnnotation(fileActor(user.id, access.workspaceId, access.membership.role), fileId, annotationId, body.data.body) });
  } catch (err) {
    return filesErrorResponse(err, "PATCH /api/files/[fileId]/annotations/[annotationId]");
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId, annotationId } = await ctx.params;
  const access = await requireWorkspaceAccess(user.id, req.nextUrl.searchParams.get("workspaceId"), "editor");
  if ("error" in access) return access.error;
  try {
    await removeAnnotation(fileActor(user.id, access.workspaceId, access.membership.role), fileId, annotationId);
    return Response.json({ ok: true });
  } catch (err) {
    return filesErrorResponse(err, "DELETE /api/files/[fileId]/annotations/[annotationId]");
  }
}
