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
  return Response.json({ file: meta });
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
      await trashFile({ workspaceId: access.workspaceId, fileId });
    }
    return Response.json({ ok: true });
  } catch (err) {
    return fsErrorToResponse(err);
  }
}
