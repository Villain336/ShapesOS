// ShapesOS — Phase 18.2 (WS=content): a file's versions.
// GET  /api/files/[fileId]/versions?workspaceId=   → { versions, retention } (viewer+)
// POST /api/files/[fileId]/versions  multipart: workspaceId, file → { version } — upload a
//        new version (the current bytes are kept; editor+ on the workspace AND the file's
//        "version" right, lib/files/acl.ts; upload safety + quota as any upload).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { DEFAULT_MAX_FILE_BYTES } from "@/lib/filesystem/service";
import { getVersionRetention, listFileVersions, overwriteFile } from "@/lib/filesystem/versions";
import { requireFileAction } from "@/lib/files/access";
import { fileActor, filesErrorResponse } from "@/lib/files/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ fileId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = await ctx.params;
  const access = await requireWorkspaceAccess(user.id, req.nextUrl.searchParams.get("workspaceId"), "viewer");
  if ("error" in access) return access.error;
  try {
    await requireFileAction(fileActor(user.id, access.workspaceId, access.membership.role), fileId, "view");
    const versions = await listFileVersions(access.workspaceId, fileId);
    if (!versions) return Response.json({ error: "File not found." }, { status: 404 });
    return Response.json({ versions, retention: await getVersionRetention(access.workspaceId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return filesErrorResponse(err, "GET /api/files/[fileId]/versions");
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = await ctx.params;
  if (!(req.headers.get("content-type") ?? "").includes("multipart")) return badRequest("Expected multipart form data.");
  const form = await req.formData();
  const workspaceId = form.get("workspaceId");
  const access = await requireWorkspaceAccess(user.id, typeof workspaceId === "string" ? workspaceId : null, "editor");
  if ("error" in access) return access.error;
  const uploaded = form.get("file");
  if (!(uploaded instanceof File) || uploaded.size === 0) return badRequest("Missing file field.");
  if (uploaded.size > DEFAULT_MAX_FILE_BYTES) return Response.json({ error: "File exceeds the 25 MB cap." }, { status: 413 });
  try {
    await requireFileAction(fileActor(user.id, access.workspaceId, access.membership.role), fileId, "version");
    const res = await overwriteFile({
      workspaceId: access.workspaceId,
      fileId,
      bytes: Buffer.from(await uploaded.arrayBuffer()),
      mimeType: uploaded.type || undefined,
      userId: user.id,
    });
    return Response.json(res, { status: 201 });
  } catch (err) {
    return filesErrorResponse(err, "POST /api/files/[fileId]/versions");
  }
}
