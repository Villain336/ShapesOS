// Marketr — programmatic SEO dataset detail API (milestone 17).
// GET    /api/programmatic/datasets/[id]?projectId=…[&rows=10] (viewer+)
// PATCH  /api/programmatic/datasets/[id] { projectId, name?, columnMapping? } (editor+)
// DELETE /api/programmatic/datasets/[id]?projectId=… (editor+)

import { forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ownedProject, requireRole } from "../../util";
import { auditProgrammatic } from "@/lib/seo/programmatic-service";

export const dynamic = "force-dynamic";

async function ownedDataset(userId: string, projectId: unknown, datasetId: string) {
  const project = await ownedProject(userId, projectId);
  if (!project) return null;
  const dataset = await prisma.programmaticDataset.findFirst({
    where: { id: datasetId, projectId: project.id },
  });
  if (!dataset) return null;
  return { project, dataset };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const owned = await ownedDataset(user.id, req.nextUrl.searchParams.get("projectId"), id);
  if (!owned) return Response.json({ error: "Dataset not found" }, { status: 404 });
  if (!(await requireRole(user.id, owned.project.id, "viewer"))) return forbidden();

  const rowLimit = Math.max(1, Math.min(100, Number(req.nextUrl.searchParams.get("rows") ?? 10) || 10));
  const allRows = Array.isArray(owned.dataset.rows) ? (owned.dataset.rows as unknown[]) : [];
  return Response.json({
    dataset: {
      id: owned.dataset.id,
      name: owned.dataset.name,
      columns: owned.dataset.schema,
      rowCount: owned.dataset.rowCount,
      columnMapping: owned.dataset.columnMapping,
      rowPreview: allRows.slice(0, rowLimit),
      createdAt: owned.dataset.createdAt,
      updatedAt: owned.dataset.updatedAt,
    },
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { id } = await params;
  const owned = await ownedDataset(user.id, body.projectId, id);
  if (!owned) return Response.json({ error: "Dataset not found" }, { status: 404 });
  if (!(await requireRole(user.id, owned.project.id, "editor"))) return forbidden();

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return Response.json({ error: "Dataset name is required" }, { status: 400 });
    data.name = name;
  }
  if (body.columnMapping !== undefined) {
    if (typeof body.columnMapping !== "object" || body.columnMapping === null || Array.isArray(body.columnMapping)) {
      return Response.json({ error: "columnMapping must be an object { variable: column }" }, { status: 400 });
    }
    const columns = Array.isArray(owned.dataset.schema) ? (owned.dataset.schema as string[]) : [];
    for (const [variable, column] of Object.entries(body.columnMapping as Record<string, unknown>)) {
      if (typeof column !== "string" || !columns.includes(column)) {
        return Response.json({ error: `Unknown column for variable "${variable}": ${String(column)}` }, { status: 400 });
      }
    }
    data.columnMapping = body.columnMapping;
  }

  const dataset = await prisma.programmaticDataset.update({ where: { id }, data });
  return Response.json({ dataset: { id: dataset.id, name: dataset.name, columnMapping: dataset.columnMapping } });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const owned = await ownedDataset(user.id, req.nextUrl.searchParams.get("projectId"), id);
  if (!owned) return Response.json({ error: "Dataset not found" }, { status: 404 });
  if (!(await requireRole(user.id, owned.project.id, "editor"))) return forbidden();

  const linked = await prisma.programmaticPage.count({ where: { datasetId: id } });
  if (linked > 0) {
    return Response.json(
      { error: `Dataset has ${linked} generated page(s); delete the pages first` },
      { status: 409 },
    );
  }
  await prisma.programmaticDataset.delete({ where: { id } });
  await auditProgrammatic(owned.project.workspaceId, owned.project.id, "programmatic_dataset_deleted",
    `Dataset deleted: ${owned.dataset.name}`).catch(() => {});
  return Response.json({ ok: true });
}
