// Marketr — delete an attachment (milestone 21, spec §5 flow 4).
// DELETE /api/projects/[id]/files/[fileId] → { ok }
// (editor+; removes the disk file for uploads; audited file_removed)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { notFound, requireProjectAccess } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: projectId, fileId } = await params;
  const access = await requireProjectAccess(user.id, projectId, "editor");
  if ("error" in access) return access.error;

  const row = await prisma.fileAttachment.findFirst({
    where: { id: fileId, projectId },
  });
  if (!row) return notFound("File not found");
  await prisma.fileAttachment.delete({ where: { id: row.id } });
  if (row.source === "upload" && row.storagePath) {
    await unlink(join(process.cwd(), row.storagePath)).catch(() => {});
  }
  await auditEvent({
    projectId,
    workspaceId: access.project.workspaceId,
    action: "file_removed",
    summary: `Removed attachment "${row.filename}"`,
    actorUserId: user.id,
  });
  return Response.json({ ok: true });
}
