// Marketr — /api/authority/intelligence/reports/:id
// GET: full report bundle. PATCH: human review — finalize (draft → ready)
// or archive, with optional initiative reprioritization.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorityGuard, badRequest, safetyError, readJson } from "@/app/api/authority/_lib";
import { getReportBundle, setReportStatus, getReport } from "@/lib/authority/intelligence/reports";
import { reprioritize } from "@/lib/authority/intelligence/plan";
import { authorityAudit } from "@/lib/authority/db";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    const row = await getReport(id, gate.workspaceId);
    if (!row) return Response.json({ error: "Report not found" }, { status: 404 });
    const bundle = await getReportBundle(id, gate.workspaceId);
    return Response.json({
      report: {
        id: row.id, status: row.status, version: row.version,
        generatedAt: row.generatedAt, pdfUrl: row.pdfUrl, createdAt: row.createdAt,
      },
      ...bundle,
    });
  } catch (err) {
    return safetyError(err);
  }
}

const patchSchema = z.object({
  status: z.enum(["ready", "archived"]).optional(),
  orderedInitiativeIds: z.array(z.string()).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  const parsed = patchSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid status payload.", parsed.error.issues);
  if (!parsed.data.status && !parsed.data.orderedInitiativeIds?.length) {
    return badRequest("Provide a status change and/or orderedInitiativeIds.");
  }
  try {
    if (parsed.data.status) {
      const updated = await setReportStatus(
        id, gate.workspaceId, gate.userId,
        parsed.data.status, parsed.data.orderedInitiativeIds,
      );
      return Response.json({ ok: true, report: { id: updated.id, status: updated.status } });
    }
    // Reorder-only: allowed on draft reports only (the human-review window).
    const row = await getReport(id, gate.workspaceId);
    if (!row) return Response.json({ error: "Report not found" }, { status: 404 });
    if (row.status !== "draft") {
      return Response.json({ error: `Report is ${row.status}; regenerate to reprioritize.` }, { status: 409 });
    }
    const bundle = await getReportBundle(id, gate.workspaceId);
    if (!bundle) return Response.json({ error: "Report data missing" }, { status: 404 });
    const reprioritized = reprioritize(bundle.plan, parsed.data.orderedInitiativeIds ?? []);
    await prisma.intelligenceReport.update({
      where: { id },
      data: { plan90dJson: reprioritized as never },
    });
    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId, actor: gate.userId,
      action: "intelligence_report_reprioritized",
      entityType: "intelligence_report", entityId: id,
      detail: { count: parsed.data.orderedInitiativeIds?.length ?? 0 },
    });
    return Response.json({ ok: true, report: { id, status: row.status } });
  } catch (err) {
    return safetyError(err);
  }
}
