// Marketr — newsletter API: CSV subscriber import (milestone 19).
// POST /api/newsletter/lists/[id]/import  (multipart: file, projectId)
// 10k-row cap, email/name column mapping, invalid rows reported per-row.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { importSubscribers } from "@/lib/newsletter/service";
import { ownedProject, requireEditor, workspacePort } from "../../../_lib";

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
  if (file.size > 5 * 1024 * 1024) return Response.json({ error: "CSV must be under 5 MB." }, { status: 400 });
  const text = await file.text();
  const portResult = await workspacePort(project.workspaceId);
  const port = "port" in portResult ? portResult.port : null;
  try {
    const outcome = await importSubscribers(prisma, id, project.workspaceId, project.id, text, port);
    return Response.json(outcome);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Import failed." }, { status: 400 });
  }
}
