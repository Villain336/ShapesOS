// ShapesOS — Phase 18.2 (WS=content): one version of a file.
// GET  /api/files/[fileId]/versions/[version]?workspaceId=[&download=1] → the bytes
//        (viewer+; served with the hardened download headers — sniffed mime, nosniff,
//        sandbox CSP; inline only for the safe list, attachment with download=1)
// POST /api/files/[fileId]/versions/[version] { workspaceId } → RESTORE: that version's
//        bytes become a NEW version; the current one is kept (editor+ and the file's
//        "version" right).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { readFileVersion, restoreFileVersion } from "@/lib/filesystem/versions";
import { buildDownloadHeaders } from "@/lib/filesystem/download";
import { requireFileAction } from "@/lib/files/access";
import { fileActor, filesErrorResponse } from "@/lib/files/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ fileId: string; version: string }> };

function versionOf(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n < 1_000_000 ? n : null;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId, version: raw } = await ctx.params;
  const version = versionOf(raw);
  if (!version) return badRequest("version is a version number.");
  const access = await requireWorkspaceAccess(user.id, req.nextUrl.searchParams.get("workspaceId"), "viewer");
  if ("error" in access) return access.error;
  try {
    await requireFileAction(fileActor(user.id, access.workspaceId, access.membership.role), fileId, "download");
    const v = await readFileVersion(access.workspaceId, fileId, version);
    if (!v) return Response.json({ error: "Version not found." }, { status: 404 });
    const name = v.current ? v.filename : v.filename.replace(/(\.[^.]+)?$/, ` (v${v.version})$1`);
    return new Response(new Uint8Array(v.bytes), {
      headers: { ...buildDownloadHeaders(v.mimeType, name, { forceAttachment: req.nextUrl.searchParams.get("download") === "1" }), "cache-control": "private, no-store" },
    });
  } catch (err) {
    return filesErrorResponse(err, "GET /api/files/[fileId]/versions/[version]");
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId, version: raw } = await ctx.params;
  const version = versionOf(raw);
  if (!version) return badRequest("version is a version number.");
  const body = z.object({ workspaceId: z.string().min(1).max(120) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest("workspaceId is required.");
  const access = await requireWorkspaceAccess(user.id, body.data.workspaceId, "editor");
  if ("error" in access) return access.error;
  try {
    await requireFileAction(fileActor(user.id, access.workspaceId, access.membership.role), fileId, "version");
    return Response.json(await restoreFileVersion(access.workspaceId, fileId, version, user.id));
  } catch (err) {
    return filesErrorResponse(err, "POST /api/files/[fileId]/versions/[version]");
  }
}
