// ShapesOS — Phase 21B (WS=drive): large files — resumable multipart upload straight to object storage.
// POST /api/drive/uploads  { workspaceId, action, … }   (editor+; the upload belongs to the person who started it)
//   initiate {dir, filename, size, mimeType?, replaceFileId?, partSize?}
//        -> {mode:"direct", maxBytes}                    local-disk storage: use POST /api/drive/upload
//        -> {mode:"multipart", uploadId, partSize, partCount, expiresAt, …}
//   parts {uploadId, parts:[1,2,3]}   -> presigned PUT urls, one per part (15 minutes); ask again to resume
//   status {uploadId}                 -> {uploaded:[…], missing:[…]}  (asked of the storage provider)
//   complete {uploadId}               -> assembles, validates (>25 MB: images, PDF and text only), scans, registers the file
//   abort {uploadId}
// The per-upload cap is quota-governed under a hard maximum (DRIVE_MAX_FILE_BYTES). Hosted deployments
// refuse to start an upload when no malware scanner is configured (CLAMAV_HOST).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { filesErrorResponse } from "@/lib/files/http";
import { normalizeFolderPath } from "@/lib/filesystem/paths";
import { abortMultipartUploadFor, completeMultipartUploadFor, initiateUpload, presignParts, uploadStatus } from "@/lib/drive/uploads";

export const dynamic = "force-dynamic";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Base = { workspaceId: z.string().min(1).max(120) };
const Body = z.discriminatedUnion("action", [
  z.object({ ...Base, action: z.literal("initiate"), dir: z.string().min(1).max(1100), filename: z.string().min(1).max(255), size: z.number().int().positive(), mimeType: z.string().max(127).optional(), replaceFileId: Id.optional(), partSize: z.number().int().positive().optional() }),
  z.object({ ...Base, action: z.literal("parts"), uploadId: Id, parts: z.array(z.number().int().positive()).min(1).max(50) }),
  z.object({ ...Base, action: z.literal("status"), uploadId: Id }),
  z.object({ ...Base, action: z.literal("complete"), uploadId: Id }),
  z.object({ ...Base, action: z.literal("abort"), uploadId: Id }),
]);

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request.");
  const b = parsed.data;
  const access = await requireWorkspaceAccess(user.id, b.workspaceId, "editor");
  if ("error" in access) return access.error;
  const actor = { workspaceId: access.workspaceId, userId: user.id, role: access.membership.role };
  const headers = { "Cache-Control": "no-store" };
  try {
    switch (b.action) {
      case "initiate": {
        const dir = normalizeFolderPath(b.dir);
        if (!dir.ok) return badRequest(dir.reason);
        return Response.json(await initiateUpload({ actor, dir: dir.path, filename: b.filename, size: b.size, mimeType: b.mimeType, replaceFileId: b.replaceFileId, partSize: b.partSize }), { status: 201, headers });
      }
      case "parts":
        return Response.json({ parts: await presignParts(actor, b.uploadId, b.parts) }, { headers });
      case "status":
        return Response.json(await uploadStatus(actor, b.uploadId), { headers });
      case "complete":
        return Response.json(await completeMultipartUploadFor(actor, b.uploadId), { headers });
      case "abort":
        await abortMultipartUploadFor(actor, b.uploadId);
        return Response.json({ ok: true }, { headers });
    }
  } catch (err) {
    return filesErrorResponse(err, "drive uploads");
  }
}
