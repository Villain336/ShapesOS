// Marketr — newsletter API: CSV subscriber import (milestone 19).
// POST /api/newsletter/lists/[id]/import  (multipart: file, projectId)
// 10k-row cap, email/name column mapping, invalid rows reported per-row.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { importSubscribers } from "@/lib/newsletter/service";
import { ownedProject, requireEditor, workspacePort } from "../../../_lib";
import { validateUploadBuffer } from "@/lib/security/upload-safety";
import { auditUploadRejected, screenUploadBuffer } from "@/lib/security/upload-audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected multipart form data." }, { status: 400 });
  }
  const project = await ownedProject(user.id, form.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No CSV file uploaded." }, { status: 400 });
  // Phase A (fix 5): CSV imports are text-only — reject binary masquerading as
  // CSV, then malware-screen the bytes before parsing.
  const csvBuf = Buffer.from(await file.arrayBuffer());
  const csvCheck = validateUploadBuffer(csvBuf, {
    filename: file.name || "import.csv",
    maxBytes: 5 * 1024 * 1024,
    category: "text",
  });
  if (!csvCheck.ok) {
    await auditUploadRejected({
      projectId: project.id,
      workspaceId: project.workspaceId,
      filename: file.name || "import.csv",
      reason: csvCheck.reason,
      actorUserId: user.id,
    });
    return Response.json({ error: csvCheck.reason }, { status: 400 });
  }
  const csvScreen = await screenUploadBuffer(csvBuf);
  if (!csvScreen.ok) {
    await auditUploadRejected({
      projectId: project.id,
      workspaceId: project.workspaceId,
      filename: file.name || "import.csv",
      reason: csvScreen.reason,
      actorUserId: user.id,
    });
    return Response.json({ error: csvScreen.reason }, { status: csvScreen.status });
  }
  const text = csvBuf.toString("utf8");
  const portResult = await workspacePort(project.workspaceId);
  const port = "port" in portResult ? portResult.port : null;
  try {
    const outcome = await importSubscribers(prisma, id, project.workspaceId, project.id, text, port);
    return Response.json(outcome);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Import failed." }, { status: 400 });
  }
}
