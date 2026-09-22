// Marketr — programmatic SEO datasets API (milestone 17).
// GET  /api/programmatic/datasets?projectId=… → datasets (viewer+).
// POST /api/programmatic/datasets (editor+):
//   - multipart form: file (CSV), name
//   - JSON: { projectId, name, columns, rows } | { projectId, name, csv }
//   Server-side CSV parse, 10k-row cap.

import { forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ownedProject, requireRole } from "../util";
import { auditProgrammatic } from "@/lib/seo/programmatic-service";
import { MAX_DATASET_ROWS, parseCsv } from "@/lib/seo/programmatic";
import { validateUploadBuffer } from "@/lib/security/upload-safety";
import { auditUploadRejected, screenUploadBuffer } from "@/lib/security/upload-audit";

export const dynamic = "force-dynamic";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

async function createDataset(
  project: { id: string; workspaceId: string },
  name: string,
  columns: string[],
  rows: Record<string, string>[],
) {
  if (!name) return { error: "Dataset name is required" };
  if (columns.length === 0) return { error: "No columns found" };
  if (new Set(columns).size !== columns.length) return { error: "Duplicate column names" };
  if (rows.length === 0) return { error: "No data rows found" };
  if (rows.length > MAX_DATASET_ROWS) {
    return { error: `Row cap exceeded: ${rows.length} rows (max ${MAX_DATASET_ROWS})` };
  }
  const dataset = await prisma.programmaticDataset.create({
    data: {
      projectId: project.id,
      name,
      schema: columns,
      rows: rows.slice(0, MAX_DATASET_ROWS),
      rowCount: Math.min(rows.length, MAX_DATASET_ROWS),
    },
  });
  await auditProgrammatic(project.workspaceId, project.id, "programmatic_dataset_uploaded",
    `Dataset uploaded: ${name} (${dataset.rowCount} rows)`).catch(() => {});
  return { dataset: { id: dataset.id, name: dataset.name, rowCount: dataset.rowCount } };
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, req.nextUrl.searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireRole(user.id, project.id, "viewer"))) return forbidden();

  const datasets = await prisma.programmaticDataset.findMany({
    where: { projectId: project.id },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true, name: true, schema: true, rowCount: true, columnMapping: true,
      createdAt: true, updatedAt: true,
      _count: { select: { pages: true } },
    },
  });
  return Response.json({
    datasets: datasets.map((d) => ({
      id: d.id,
      name: d.name,
      columns: d.schema,
      rowCount: d.rowCount,
      columnMapping: d.columnMapping,
      pageCount: d._count.pages,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const contentType = req.headers.get("content-type") ?? "";
  let projectId: unknown;
  let name = "";
  let columns: string[] = [];
  let rows: Record<string, string>[] = [];

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    projectId = form.get("projectId");
    name = String(form.get("name") ?? "").trim();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "CSV file is required" }, { status: 400 });
    // Phase A (fix 5): datasets accept text CSV only — reject binary uploads,
    // then malware-screen before parsing. Rejections are audit-logged.
    const dsBuf = Buffer.from(await file.arrayBuffer());
    const dsCheck = validateUploadBuffer(dsBuf, {
      filename: file.name || "dataset.csv",
      maxBytes: MAX_UPLOAD_BYTES,
      category: "text",
    });
    const dsScreen = dsCheck.ok ? await screenUploadBuffer(dsBuf) : null;
    const dsRejection = !dsCheck.ok
      ? { reason: dsCheck.reason, status: 400 as const }
      : dsScreen && !dsScreen.ok
        ? { reason: dsScreen.reason, status: dsScreen.status }
        : null;
    if (dsRejection) {
      const auditProject = await ownedProject(user.id, projectId);
      if (auditProject) {
        await auditUploadRejected({
          projectId: auditProject.id,
          workspaceId: auditProject.workspaceId,
          filename: file.name || "dataset.csv",
          reason: dsRejection.reason,
          actorUserId: user.id,
        });
      }
      return Response.json({ error: dsRejection.reason }, { status: dsRejection.status });
    }
    const text = dsBuf.toString("utf8");
    const parsed = parseCsv(text);
    columns = parsed.columns;
    rows = parsed.rows;
    if (!name) name = file.name.replace(/\.csv$/i, "") || "Untitled dataset";
  } else {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    projectId = body.projectId;
    name = typeof body.name === "string" ? body.name.trim() : "";
    if (typeof body.csv === "string") {
      const parsed = parseCsv(body.csv);
      columns = parsed.columns;
      rows = parsed.rows;
    } else if (Array.isArray(body.columns) && Array.isArray(body.rows)) {
      columns = (body.columns as unknown[]).map(String).map((c) => c.trim()).filter(Boolean);
      rows = (body.rows as unknown[]).filter((r) => typeof r === "object" && r !== null) as Record<string, string>[];
    } else {
      return Response.json({ error: "Provide csv text or { columns, rows }" }, { status: 400 });
    }
  }

  const project = await ownedProject(user.id, projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireRole(user.id, project.id, "editor"))) return forbidden();

  const result = await createDataset(project, name, columns, rows);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  return Response.json(result, { status: 201 });
}
