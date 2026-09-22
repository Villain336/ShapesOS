// Marketr — attachment download + delete (milestone 21).
// GET    /api/projects/[id]/files/[fileId]/download → bytes (uploads only; viewer+)
// DELETE /api/projects/[id]/files/[fileId] → { ok } (editor+; deletes the disk file for uploads; audited)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { notFound, requireProjectAccess } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; fileId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: projectId, fileId } = await params;
  const access = await requireProjectAccess(user.id, projectId, "viewer");
  if ("error" in access) return access.error;

  const row = await prisma.fileAttachment.findFirst({
    where: { id: fileId, projectId },
  });
  if (!row || row.source !== "upload" || !row.storagePath) {
    return notFound("Upload not found");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(join(process.cwd(), row.storagePath));
  } catch {
    return notFound("File missing from disk");
  }
  const body = new Uint8Array(bytes);
  return new Response(body, {
    headers: {
      "content-type": row.mimeType ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${row.filename.replace(/["\\]/g, "_")}"`,
    },
  });
}
