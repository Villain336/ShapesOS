// ShapesOS — Phase 21B (WS=drive): upload through the browser form, for files up to 25 MB and
// for whole folders (the browser sends one request per file with its relative path).
// POST /api/drive/upload  multipart: workspaceId, dir, file, relativePath?, replace?   (editor+)
//   dir            the folder to put it in (display path: /home/<me>/Docs, /shared/Marketing, …)
//   relativePath   "MyFolder/sub/a.txt" from webkitdirectory: the folders are created beneath dir
//   replace=1      a file already there gets a NEW VERSION instead of a 409
// Bigger files use the resumable multipart protocol (POST /api/drive/uploads). Upload safety, the
// malware scan (required on hosted), quota, versions and the change journal all apply.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { filesErrorResponse } from "@/lib/files/http";
import { DEFAULT_MAX_FILE_BYTES, FsError } from "@/lib/filesystem/core";
import { normalizeFolderPath, sanitizeUploadName } from "@/lib/filesystem/paths";
import { writeFileAs } from "@/lib/drive/ops";

export const dynamic = "force-dynamic";

/** Folder segments from a browser-supplied relative path: sanitised, no empty / dot segments, bounded. */
export function relativeDirs(relativePath: string | null): string[] {
  if (!relativePath) return [];
  const parts = relativePath.split(/[\\/]/).slice(0, -1).filter((s) => s && s !== "." && s !== "..");
  return parts.slice(0, 24).map((s) => sanitizeUploadName(s));
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!(req.headers.get("content-type") ?? "").includes("multipart")) return badRequest("Expected multipart form data.");
  const form = await req.formData();
  const access = await requireWorkspaceAccess(user.id, String(form.get("workspaceId") ?? ""), "editor");
  if ("error" in access) return access.error;
  const uploaded = form.get("file");
  if (!(uploaded instanceof File)) return badRequest("Missing file field.");
  if (uploaded.size === 0) return badRequest("File is empty.");
  if (uploaded.size > DEFAULT_MAX_FILE_BYTES) return Response.json({ error: "Files over 25 MB upload in parts: use the resumable upload.", code: "use_multipart" }, { status: 413 });
  const dirIn = normalizeFolderPath(String(form.get("dir") ?? ""));
  if (!dirIn.ok) return badRequest(dirIn.reason);
  const dir = [dirIn.path, ...relativeDirs(typeof form.get("relativePath") === "string" ? (form.get("relativePath") as string) : null)].join("/");
  const actor = { workspaceId: access.workspaceId, userId: user.id, role: access.membership.role };
  try {
    const { file, created, version } = await writeFileAs(actor, {
      dir,
      filename: uploaded.name || "file",
      bytes: Buffer.from(await uploaded.arrayBuffer()),
      mimeType: uploaded.type || undefined,
      overwrite: form.get("replace") === "1",
      maxBytes: DEFAULT_MAX_FILE_BYTES,
    });
    return Response.json({ file, created, version }, { status: created ? 201 : 200 });
  } catch (err) {
    if (err instanceof FsError && err.code === "conflict") return Response.json({ error: err.message, code: "conflict", canReplace: true }, { status: 409 });
    return filesErrorResponse(err, "drive upload");
  }
}
