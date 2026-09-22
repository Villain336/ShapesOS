// Marketr — programmatic SEO generation API (milestone 17).
// POST /api/programmatic/generate { projectId, templateId, datasetId,
//   action: "preview" | "generate", limit? } (editor+).
// "preview" renders the first N pages in memory (no DB writes).
// "generate" runs the full chunked batch (idempotent on template+slug).

import { forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { ownedProject, requireRole } from "../util";
import {
  generateProgrammaticPages,
  previewProgrammaticPages,
} from "@/lib/seo/programmatic-service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { projectId?: string; templateId?: string; datasetId?: string; action?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireRole(user.id, project.id, "editor"))) return forbidden();

  if (typeof body.templateId !== "string" || !body.templateId) {
    return Response.json({ error: "templateId is required" }, { status: 400 });
  }
  if (typeof body.datasetId !== "string" || !body.datasetId) {
    return Response.json({ error: "datasetId is required" }, { status: 400 });
  }

  try {
    if (body.action === "preview") {
      const preview = await previewProgrammaticPages({
        projectId: project.id,
        templateId: body.templateId,
        datasetId: body.datasetId,
        limit: body.limit,
      });
      return Response.json({ action: "preview", ...preview });
    }
    if (body.action === "generate") {
      const result = await generateProgrammaticPages({
        workspaceId: project.workspaceId,
        projectId: project.id,
        templateId: body.templateId,
        datasetId: body.datasetId,
        actor: "user",
      });
      return Response.json({ action: "generate", ...result });
    }
    return Response.json({ error: 'action must be "preview" or "generate"' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Generation failed" }, { status: 400 });
  }
}
