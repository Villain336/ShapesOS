// Marketr — project file attachments (milestone 21, spec §5 flow 4).
// GET  /api/projects/[projectId]/files → { files } (viewer+)
// POST /api/projects/[projectId]/files — multipart (editor+; audited file_attached):
//   - `file` (File) → stored under .data/attachments/<projectId>/, 25MB cap, source=upload
//   - or fields { connectorKey, externalRef, filename, mimeType? } → source=connector
//     (connectorKey must be a bound + active data source for the project)
// Nothing is indexed; removing the attachment removes the agent's access.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { badRequest, requireProjectAccess } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

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
  const { projectId } = await params;
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
  const { projectId } = await params;
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
    if (uploaded.size > MAX_BYTES) {
      return badRequest(`File is too large (max ${MAX_BYTES / 1024 / 1024}MB)`);
    }
    const safe = (uploaded.name || "file")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 120);
    const stored = `${randomUUID()}-${safe}`;
    const dir = join(process.cwd(), ".data", "attachments", projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, stored), Buffer.from(await uploaded.arrayBuffer()));

    const row = await prisma.fileAttachment.create({
      data: {
        projectId,
        source: "upload",
        filename: (uploaded.name || "file").slice(0, 255),
        mimeType: uploaded.type || null,
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
