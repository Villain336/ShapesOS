// Marketr — /api/authority/intelligence/reports
// POST: compile the 12 audits → opportunities → 90-day plan (status draft).
// GET: list reports (metadata only).

import type { NextRequest } from "next/server";
import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { compileReport, listReports } from "@/lib/authority/intelligence/reports";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  try {
    const { report, bundle } = await compileReport(gate.workspaceId, gate.userId);
    return Response.json({
      ok: true,
      report: { id: report.id, status: report.status, generatedAt: report.generatedAt },
      completeness: bundle.completeness,
      opportunityCount: bundle.opportunities.length,
      initiativeCount: bundle.plan.initiatives.length,
    }, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}

export async function GET(_req: NextRequest) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  try {
    const reports = await listReports(gate.workspaceId);
    return Response.json({ reports });
  } catch (err) {
    return safetyError(err);
  }
}
