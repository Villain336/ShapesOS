// Marketr — workspace filesystem API (Phase B, W3, track B1).
// GET  /api/files?workspaceId=&prefix=[&trashed=1] → DirListing + quota (viewer+)
// POST /api/files — multipart: workspaceId, path (target dir), file (editor+)
//
// All RBAC through requireWorkspaceAccess (recognized by the M11 scan).
// Uploads are restricted to /files and /memory — /skills is reserved for the
// skill-install flow and /artifacts for internal run outputs (THREAT-MODEL §9).
// Upload safety runs inside writeFile; the route enforces the 25 MB cap.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import {
  DEFAULT_MAX_FILE_BYTES,
  FsError,
  getQuota,
  listDir,
  writeFile,
} from "@/lib/filesystem/service";
import { normalizeLogicalPath } from "@/lib/filesystem/paths";
import { safeFilename } from "@/lib/security/upload-safety";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const API_WRITABLE_ROOTS = ["/files", "/memory"] as const;

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
              : 400;
    return Response.json({ error: err.message }, { status });
  }
  throw err;
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const qs = req.nextUrl.searchParams;
  const workspaceId = qs.get("workspaceId");
  const access = await requireWorkspaceAccess(user.id, workspaceId, "viewer");
  if ("error" in access) return access.error;

  const trashed = qs.get("trashed") === "1";
  if (trashed) {
    // Editor+ can see the trash bin.
    const m = await requireWorkspaceAccess(user.id, workspaceId, "editor");
    if ("error" in m) return m.error;
    const rows = await prisma.workspaceFile.findMany({
      where: { workspaceId: access.workspaceId, trashedAt: { not: null } },
      orderBy: { trashedAt: "desc" },
      take: 200,
    });
    return Response.json({
      files: rows.map((r) => ({
        id: r.id,
        logicalPath: r.logicalPath,
        filename: r.filename,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        kind: r.kind,
        trashedAt: r.trashedAt?.toISOString() ?? null,
      })),
    });
  }

  try {
    const listing = await listDir({ workspaceId: access.workspaceId, prefix: qs.get("prefix") ?? "/" });
    const quota = await getQuota({ workspaceId: access.workspaceId });
    return Response.json({ ...listing, quota });
  } catch (err) {
    return fsErrorToResponse(err);
  }
}

const UploadMetaSchema = z.object({
  workspaceId: z.string().min(1).max(120),
  path: z.string().min(1).max(512).default("/files"),
});

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart")) return badRequest("Expected multipart form data.");
  const form = await req.formData();
  const meta = UploadMetaSchema.safeParse({
    workspaceId: form.get("workspaceId"),
    path: form.get("path") ?? "/files",
  });
  if (!meta.success) return badRequest("Invalid workspaceId or path.");
  const { workspaceId } = meta.data;

  const access = await requireWorkspaceAccess(user.id, workspaceId, "editor");
  if ("error" in access) return access.error;

  const uploaded = form.get("file");
  if (!(uploaded instanceof File)) return badRequest("Missing file field.");
  if (uploaded.size === 0) return badRequest("File is empty.");
  if (uploaded.size > DEFAULT_MAX_FILE_BYTES) {
    return Response.json({ error: "File exceeds the 25 MB cap." }, { status: 413 });
  }

  // Target directory must be one of the API-writable roots.
  const dirCheck = normalizeLogicalPath(`${meta.data.path.replace(/\/+$/, "")}/__probe__`);
  if (!dirCheck.ok) return badRequest(dirCheck.reason);
  const dir = dirCheck.path.replace(/\/__probe__$/, "");
  if (!(API_WRITABLE_ROOTS as readonly string[]).some((r) => dir === r || dir.startsWith(`${r}/`))) {
    return Response.json(
      { error: "Uploads are only allowed under /files and /memory." },
      { status: 403 },
    );
  }

  const filename = safeFilename(uploaded.name || "file");
  const logicalPath = `${dir}/${filename}`;
  try {
    const buf = Buffer.from(await uploaded.arrayBuffer());
    const file = await writeFile({
      workspaceId: access.workspaceId,
      logicalPath,
      kind: dirCheck.kind,
      bytes: buf,
      mimeType: uploaded.type || undefined,
      createdBy: user.id,
      maxBytes: DEFAULT_MAX_FILE_BYTES,
    });
    return Response.json({ file }, { status: 201 });
  } catch (err) {
    return fsErrorToResponse(err);
  }
}
