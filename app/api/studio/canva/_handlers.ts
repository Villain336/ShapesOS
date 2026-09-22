// Marketr — studio API: Canva designs, brand templates, autofill, export (milestone 22).
// GET  /api/studio/canva/designs?projectId=&query=
// GET  /api/studio/canva/brand-templates?projectId=
// POST /api/studio/canva/autofill { projectId, brandTemplateId, data } (editor+)
// POST /api/studio/canva/export { projectId, designId, format } (editor+)
// GET  /api/studio/canva/export/[exportId]?projectId= (poll)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createCanvaPort } from "@/lib/studio/canva";
import {
  autofillStudioTemplate,
  listStudioBrandTemplates,
  listStudioDesigns,
  pollStudioExport,
  startStudioExport,
} from "@/lib/studio/service";
import {
  canvaClientConfig,
  ownedProject,
  readJson,
  requireEditor,
} from "../_lib";

function port() {
  return createCanvaPort();
}

export async function listDesignsHandler(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const project = await ownedProject(user.id, params.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  try {
    const designs = await listStudioDesigns(
      prisma,
      project.workspaceId,
      port(),
      canvaClientConfig(),
      { query: params.get("query") ?? undefined, folderId: params.get("folderId") ?? undefined },
    );
    return Response.json({ designs });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to list designs." },
      { status: 502 },
    );
  }
}

export async function listBrandTemplatesHandler(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  try {
    const result = await listStudioBrandTemplates(prisma, project.workspaceId, port(), canvaClientConfig());
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to list brand templates." },
      { status: 502 },
    );
  }
}

export async function autofillHandler(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  try {
    const result = await autofillStudioTemplate(
      prisma,
      project.workspaceId,
      project.id,
      port(),
      canvaClientConfig(),
      {
        brandTemplateId: String(body.brandTemplateId ?? ""),
        data: (body.data ?? {}) as Record<string, { type: "text" | "image"; text?: string; assetId?: string }>,
      },
    );
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Autofill failed." },
      { status: 502 },
    );
  }
}

export async function startExportHandler(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  const format = String(body.format ?? "png");
  if (!["png", "jpg", "pdf", "mp4"].includes(format)) {
    return Response.json({ error: "Unsupported export format." }, { status: 400 });
  }
  try {
    const result = await startStudioExport(prisma, project.workspaceId, port(), canvaClientConfig(), {
      designId: String(body.designId ?? ""),
      format: format as "png" | "jpg" | "pdf" | "mp4",
    });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Export failed." },
      { status: 502 },
    );
  }
}

export async function pollExportHandler(req: Request, exportId: string) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  try {
    const job = await pollStudioExport(prisma, project.workspaceId, port(), canvaClientConfig(), exportId);
    return Response.json({ export: job });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Export poll failed." },
      { status: 502 },
    );
  }
}
