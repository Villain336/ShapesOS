// Marketr — project file attachments (milestone 21, spec §5 flow 4).
// GET  /api/projects/[id]/files → { files } (viewer+)
// POST /api/projects/[id]/files — multipart (editor+; audited file_attached):
//   - `file` (File) → stored under .data/attachments/<projectId>/, 25MB cap, source=upload
//   - or fields { connectorKey, externalRef, filename, mimeType? } → source=connector
//     (connectorKey must be a bound + active data source for the project)
// Nothing is indexed; removing the attachment removes the agent's access.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { badRequest, requireProjectAccess } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import {
  resolveWithinDir,
  validateUploadBuffer,
} from "@/lib/security/upload-safety";
import { auditUploadRejected, screenUploadBuffer } from "@/lib/security/upload-audit";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_BYTES = 25 * 1024 * 1024;

function publicFile(f: {
  id: string;
  projectId: string;
  sessionId: string | null;
  source: string;
  connectorKey: string | null;
  externalRef: string | null;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedBy: string;
  createdAt: Date;
}) {
  return {
    id: f.id,
    projectId: f.projectId,
    sessionId: f.sessionId,
    source: f.source,
    connectorKey: f.connectorKey,
    externalRef: f.externalRef,
    filename: f.filename,
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    uploadedBy: f.uploadedBy,
    createdAt: f.createdAt.toISOString(),
  };
}

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: projectId } = await params;
  const access = await requireProjectAccess(user.id, projectId, "viewer");
  if ("error" in access) return access.error;

  const files = await prisma.fileAttachment.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
  return Response.json({ files: files.map(publicFile) });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: projectId } = await params;
  const access = await requireProjectAccess(user.id, projectId, "editor");
  if ("error" in access) return access.error;

  const contentType = req.headers.get("content-type") ?? "";
  const form = contentType.includes("multipart")
    ? await req.formData()
    : null;
  const jsonBody =
    !form && contentType.includes("application/json")
      ? ((await req.json().catch(() => null)) as Record<string, unknown> | null)
      : null;

  const field = (name: string): string | null => {
    if (form) {
      const v = form.get(name);
      return typeof v === "string" ? v : null;
    }
    const v = jsonBody?.[name];
    return typeof v === "string" ? v : null;
  };

  const uploaded = form?.get("file");
  if (uploaded instanceof File) {
    // Phase A (fix 5): the project id becomes a path segment — keep it to a
    // strict alphabet so it can never escape the attachments directory.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
      return badRequest("Invalid project id");
    }
    const originalName = uploaded.name || "file";
    const buf = Buffer.from(await uploaded.arrayBuffer());
    const check = validateUploadBuffer(buf, {
      filename: originalName,
      maxBytes: MAX_BYTES,
      category: "default",
    });
    if (!check.ok) {
      await auditUploadRejected({
        projectId,
        workspaceId: access.project.workspaceId,
        filename: originalName,
        reason: check.reason,
        actorUserId: user.id,
      });
      return badRequest(check.reason);
    }
    const screen = await screenUploadBuffer(buf);
    if (!screen.ok) {
      await auditUploadRejected({
        projectId,
        workspaceId: access.project.workspaceId,
        filename: originalName,
        reason: screen.reason,
        actorUserId: user.id,
      });
      return Response.json({ error: screen.reason }, { status: screen.status });
    }
    // Stored under a random UUID with the *sniffed* extension — the user's
    // filename never touches the filesystem. The original name lives in the DB.
    const stored = `${randomUUID()}.${check.ext}`;
    const dir = join(process.cwd(), ".data", "attachments", projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(resolveWithinDir(dir, stored), buf);

    const row = await prisma.fileAttachment.create({
      data: {
        projectId,
        source: "upload",
        filename: (uploaded.name || "file").slice(0, 255),
        mimeType: check.mime,
        sizeBytes: uploaded.size,
        storagePath: `.data/attachments/${projectId}/${stored}`,
        uploadedBy: user.id,
      },
    });
    await auditEvent({
      projectId,
      workspaceId: access.project.workspaceId,
      action: "file_attached",
      summary: `Attached file "${row.filename}" (upload)`,
      actorUserId: user.id,
    });
    return Response.json({ file: publicFile(row) }, { status: 201 });
  }

  // Connector reference: { connectorKey, externalRef, filename, mimeType? }.
  const connectorKey = field("connectorKey");
  const filename = field("filename");
  if (!connectorKey || !filename) {
    return badRequest("Provide either a `file` upload or { connectorKey, filename } fields");
  }
  const binding = await prisma.projectDataSource.findFirst({
    where: { projectId, connectorKey },
    include: { connection: true },
  });
  if (!binding || binding.connection?.status !== "active") {
    return badRequest(`Connector "${connectorKey}" is not bound or not active for this project`);
  }
  const row = await prisma.fileAttachment.create({
    data: {
      projectId,
      source: "connector",
      connectorKey,
      externalRef: field("externalRef"),
      filename: filename.slice(0, 255),
      mimeType: field("mimeType"),
      uploadedBy: user.id,
    },
  });
  await auditEvent({
    projectId,
    workspaceId: access.project.workspaceId,
    action: "file_attached",
    summary: `Attached file "${row.filename}" (via ${connectorKey})`,
    actorUserId: user.id,
  });
  return Response.json({ file: publicFile(row) }, { status: 201 });
}
