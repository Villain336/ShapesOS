// Marketr — workspace filesystem: file detail, download, mutate, trash, purge.
// GET    /api/files/[fileId]?workspaceId= → metadata (viewer+)
// GET    /api/files/[fileId]?workspaceId=&download=1 → bytes (viewer+)
// PATCH  /api/files/[fileId] { workspaceId, action: rename|move|trash|restore, ... } (editor+)
// DELETE /api/files/[fileId]?workspaceId= → trash (editor+); &purge=1 → purge (admin+)
//
// Download hardening (THREAT-MODEL §7/§8): served MIME comes from the sniffed
// mime recorded at upload (never the filename); inline only for a small safe
// list; everything else is attachment. X-Content-Type-Options: nosniff and
// Content-Security-Policy: sandbox on every download.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, notFound, requireWorkspaceAccess } from "@/lib/route-utils";
import { HttpError } from "@/lib/api/errors";
import {
  FsError,
  deleteFile,
  getFile,
  moveFile,
  readFile,
  renameFile,
  restoreFile,
  trashFile,
} from "@/lib/filesystem/service";
import { buildDownloadHeaders } from "@/lib/filesystem/download";
// Phase 18.2 (WS=content): per-file access on top of the workspace role.
import { fileRoleFor, requireFileAction } from "@/lib/files/access";
import { fileActor } from "@/lib/files/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ fileId: string }> };

const INLINE_SAFE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

function fsErrorToResponse(err: unknown) {
  if (err instanceof FsError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "conflict"
          ? 409
          : err.code === "quota_exceeded"
            ? 413
            : err.code === "too_large"
              ? 413
              : err.code === "invalid_state"
                ? 409
                : 400;
    return Response.json({ error: err.message }, { status });
  }
  throw err;
}

export async function GET(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = await params;
  const qs = req.nextUrl.searchParams;
  const access = await requireWorkspaceAccess(user.id, qs.get("workspaceId"), "viewer");
  if ("error" in access) return access.error;

  if (qs.get("download") === "1") {
    const res = await readFile({ workspaceId: access.workspaceId, fileId }).catch(
      (err) => fsErrorToResponse(err),
    );
    if (res instanceof Response) return res;
    if (!res) return notFound("File not found");
    return new Response(new Uint8Array(res.bytes), {
      // Served from the sniffed mime stored at upload — never from the
      // filename extension or a client header (content-type confusion).
      headers: buildDownloadHeaders(res.meta.mimeType, res.meta.filename),
    });
  }

  const meta = await getFile({ workspaceId: access.workspaceId, fileId }).catch((err) =>
    fsErrorToResponse(err),
  );
  if (meta instanceof Response) return meta;
  if (!meta) return notFound("File not found");
  // Phase 18.2: the caller's role on this file (what the Files UI offers).
  const fr = await fileRoleFor(fileActor(user.id, access.workspaceId, access.membership.role), fileId);
  return Response.json({ file: meta, role: fr?.role ?? "viewer" });
}

const PatchSchema = z
  .object({
    workspaceId: z.string().min(1).max(120),
    action: z.enum(["rename", "move", "trash", "restore"]),
    filename: z.string().min(1).max(120).optional(),
    newPath: z.string().min(1).max(512).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "rename" && !v.filename) {
      ctx.addIssue({ code: "custom", message: "filename is required for rename." });
    }
    if ((v.action === "move" || v.action === "restore") && v.newPath === undefined && v.action === "move") {
      ctx.addIssue({ code: "custom", message: "newPath is required for move." });
    }
  });

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return badRequest("Invalid request.");
  const { workspaceId, action } = parsed.data;

  const access = await requireWorkspaceAccess(user.id, workspaceId, "editor");
  if ("error" in access) return access.error;

  try {
    // Phase 18.2: the file's own access can narrow an editor (trash/rename/move need "edit").
    await requireFileAction(fileActor(user.id, access.workspaceId, access.membership.role), fileId, action === "trash" ? "trash" : "edit").catch(async (err) => {
      // Restoring a trashed file: it isn't live, so the per-file check can't load it — the workspace role (editor+) stands.
      if (action === "restore") return null;
      throw err;
    });
    const ws = { workspaceId: access.workspaceId, fileId };
    const file =
      action === "rename"
        ? await renameFile({ ...ws, filename: parsed.data.filename! })
        : action === "move"
          ? await moveFile({ ...ws, newPath: parsed.data.newPath! })
          : action === "trash"
            ? await trashFile(ws)
            : await restoreFile({ ...ws, newPath: parsed.data.newPath });
    return Response.json({ file });
  } catch (err) {
    if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
    return fsErrorToResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = await params;
  const qs = req.nextUrl.searchParams;
  const workspaceId = qs.get("workspaceId");
  const purge = qs.get("purge") === "1";

  // Purge is destructive: admin+. Trash: editor+.
  const access = await requireWorkspaceAccess(user.id, workspaceId, purge ? "admin" : "editor");
  if ("error" in access) return access.error;

  try {
    if (purge) {
      await deleteFile({ workspaceId: access.workspaceId, fileId });
    } else {
      // Phase 18.2: the file's own access can narrow an editor.
      await requireFileAction(fileActor(user.id, access.workspaceId, access.membership.role), fileId, "trash");
      await trashFile({ workspaceId: access.workspaceId, fileId });
    }
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
    return fsErrorToResponse(err);
  }
}
