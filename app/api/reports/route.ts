// Marketr — generated reports API (milestone 12).
// GET  /api/reports?templateId=…   → { reports } (newest first)
// POST /api/reports  { templateId, clientId?, period? } → { report } (201)
//   Generates the branded PDF on demand (editor+). Failures return 500 with
//   the report row left in `failed` status for inspection.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { generateReport } from "@/lib/pdf/generate";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const templateId = req.nextUrl.searchParams.get("templateId");

  const reports = await prisma.report.findMany({
    where: {
      template: { workspaceId: workspace.id },
      ...(templateId ? { templateId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      template: { select: { id: true, name: true } },
      brandKit: { select: { id: true, name: true } },
      client: { select: { id: true, name: true } },
    },
  });
  return Response.json({ reports });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: { templateId?: string; clientId?: string; period?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.templateId) {
    return Response.json({ error: "templateId is required" }, { status: 400 });
  }
  const template = await prisma.reportTemplate.findFirst({
    where: { id: body.templateId, workspaceId: workspace.id },
  });
  if (!template) return Response.json({ error: "Template not found" }, { status: 404 });

  try {
    const report = await generateReport({
      templateId: template.id,
      actor: "user",
      actorId: user.id,
      clientId: body.clientId,
      period: body.period,
    });
    return Response.json({ report }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Report generation failed: ${message}` }, { status: 500 });
  }
}
