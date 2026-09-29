// Marketr — Phase 16 slice 9: branded report engine API.
// POST /api/reports/send-approvals  → draft a report for gate approval (editor+)
//   { templateName, templateVersion?, brandKitId?, clientName, period,
//     meta?: Record<string,string>, figures: [{ key, label, value, delta?, source?: { provider, ref, capturedAt? } }] }
//   → 201 { approval }  (status "pending", or "flagged" when figures lack sources)
// GET  /api/reports/send-approvals  → list this workspace's send approvals (newest first)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { draftReportSend } from "@/lib/reports/report-gate";
import type { ReportFigure } from "@/lib/reports/figures";

function validFigure(f: unknown): f is ReportFigure {
  if (!f || typeof f !== "object") return false;
  const r = f as Record<string, unknown>;
  if (typeof r.key !== "string" || !r.key.trim()) return false;
  if (typeof r.label !== "string" || !r.label.trim()) return false;
  if (typeof r.value !== "string") return false;
  if (r.delta !== undefined && typeof r.delta !== "string") return false;
  if (r.source !== undefined && r.source !== null) {
    const s = r.source as Record<string, unknown>;
    if (typeof s.provider !== "string" || typeof s.ref !== "string") return false;
    if (s.capturedAt !== undefined && typeof s.capturedAt !== "string") return false;
  }
  return true;
}

function serialize(row: Record<string, unknown>) {
  return {
    id: row.id,
    templateName: row.templateName,
    templateVersion: row.templateVersion,
    brandKitId: row.brandKitId,
    clientName: row.clientName,
    period: row.period,
    payload: row.payload,
    status: row.status,
    reviewNote: row.reviewNote,
    pdfPath: row.pdfPath,
    error: row.error,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const approvals = await prisma.reportSendApproval.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return Response.json({ approvals: approvals.map((a) => serialize(a as unknown as Record<string, unknown>)) });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: {
    templateName?: string;
    templateVersion?: string;
    brandKitId?: string;
    clientName?: string;
    period?: string;
    meta?: Record<string, string>;
    figures?: unknown[];
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.templateName?.trim()) return Response.json({ error: "templateName is required" }, { status: 400 });
  if (!body.clientName?.trim()) return Response.json({ error: "clientName is required" }, { status: 400 });
  if (!body.period?.trim()) return Response.json({ error: "period is required" }, { status: 400 });
  if (!Array.isArray(body.figures) || body.figures.length === 0) {
    return Response.json({ error: "At least one figure is required" }, { status: 400 });
  }
  for (const f of body.figures) {
    if (!validFigure(f)) return Response.json({ error: "Each figure needs { key, label, value } (strings) and an optional source { provider, ref }" }, { status: 400 });
  }
  if (body.meta && (typeof body.meta !== "object" || Array.isArray(body.meta))) {
    return Response.json({ error: "meta must be an object of strings" }, { status: 400 });
  }

  try {
    const approval = await draftReportSend(prisma, {
      workspaceId: workspace.id,
      createdBy: user.id,
      templateName: body.templateName.trim(),
      templateVersion: body.templateVersion?.trim() || "latest",
      brandKitId: body.brandKitId || null,
      clientName: body.clientName.trim(),
      period: body.period.trim(),
      meta: body.meta ?? {},
      figures: body.figures as ReportFigure[],
    });
    return Response.json({ approval: serialize(approval as unknown as Record<string, unknown>) }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Draft failed" }, { status: 400 });
  }
}
