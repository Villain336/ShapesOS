// Marketr — report template CRUD API (milestone 12).
// GET  /api/report-templates            → { templates }
// POST /api/report-templates            { name, type?, content, brandKitId?, projectId?, schedule? } → { template } (201)
// Reads: any workspace member. Writes: editor+.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";

const SCHEDULES = new Set(["manual", "weekly", "monthly"]);
const TYPES = new Set(["ranking", "custom"]);

function validTiptapDoc(content: unknown): boolean {
  return (
    !!content &&
    typeof content === "object" &&
    (content as { type?: string }).type === "doc" &&
    Array.isArray((content as { content?: unknown }).content)
  );
}

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const templates = await prisma.reportTemplate.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { updatedAt: "desc" },
    include: {
      brandKit: { select: { id: true, name: true } },
      project: { select: { id: true, domain: true } },
      _count: { select: { reports: true } },
    },
  });
  return Response.json({ templates });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: {
    name?: string;
    type?: string;
    content?: unknown;
    brandKitId?: string;
    projectId?: string;
    schedule?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.name?.trim()) return Response.json({ error: "Name is required" }, { status: 400 });
  if (!validTiptapDoc(body.content)) {
    return Response.json({ error: "content must be a Tiptap JSON document" }, { status: 400 });
  }
  if (body.type && !TYPES.has(body.type)) {
    return Response.json({ error: "type must be ranking or custom" }, { status: 400 });
  }
  if (body.schedule && !SCHEDULES.has(body.schedule)) {
    return Response.json({ error: "schedule must be manual, weekly, or monthly" }, { status: 400 });
  }
  // Scope brand kit + project to this workspace.
  if (body.brandKitId) {
    const kit = await prisma.brandKit.findFirst({ where: { id: body.brandKitId, workspaceId: workspace.id } });
    if (!kit) return Response.json({ error: "Brand kit not found" }, { status: 404 });
  }
  if (body.projectId) {
    const project = await prisma.project.findFirst({ where: { id: body.projectId, workspaceId: workspace.id } });
    if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const template = await prisma.reportTemplate.create({
    data: {
      workspaceId: workspace.id,
      name: body.name.trim().slice(0, 120),
      type: body.type ?? "custom",
      content: body.content as object,
      brandKitId: body.brandKitId || null,
      projectId: body.projectId || null,
      schedule: body.schedule ?? "manual",
    },
  });
  return Response.json({ template }, { status: 201 });
}
