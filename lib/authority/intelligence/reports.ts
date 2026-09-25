// Marketr — Phase 6 I1: report compile + store service.
//
// compileReport(): build context → 12 audits → opportunities → 90-day plan
//   → IntelligenceReport row (status draft) → authority audit log.
// Human review flips draft → ready. PDF renders on demand.

import { prisma } from "@/lib/prisma";
import { createId } from "@/lib/media/ids";
import { authorityAudit } from "@/lib/authority/db";
import { buildAuditContext } from "./connectors";
import { runAllAudits } from "./audits";
import { deriveOpportunities } from "./opportunities";
import { compilePlan, reprioritize } from "./plan";
import type {
  AuditId, AuditResult, Completeness, GrowthPlan, ReportBundle,
  RevenueOpportunity,
} from "./types";
import { AUDIT_ORDER } from "./types";

function toBundle(input: {
  audits: AuditResult[]; opportunities: RevenueOpportunity[]; plan: GrowthPlan;
}): ReportBundle {
  const completeness = {} as Record<AuditId, Completeness>;
  for (const a of input.audits) completeness[a.id] = a.completeness;
  return {
    audits: input.audits,
    opportunities: input.opportunities,
    plan: input.plan,
    completeness,
    generatedAt: new Date().toISOString(),
  };
}

export async function compileReport(workspaceId: string, userId: string) {
  const ctx = await buildAuditContext(workspaceId, userId);
  const audits = await runAllAudits(ctx);
  const opportunities = deriveOpportunities(audits);
  const plan = compilePlan(opportunities, audits);
  const bundle = toBundle({ audits, opportunities, plan });

  const report = await prisma.intelligenceReport.create({
    data: {
      id: createId(),
      workspaceId,
      version: 1,
      auditCompletenessJson: bundle.completeness as never,
      auditsJson: audits as never,
      opportunitiesJson: opportunities as never,
      plan90dJson: plan as never,
      status: "draft",
      generatedAt: new Date(),
      generatedBy: userId,
    },
  });

  await authorityAudit.logAsync({
    workspaceId,
    actor: userId,
    action: "intelligence_report_compiled",
    entityType: "intelligence_report",
    entityId: report.id,
    detail: {
      audits: audits.length,
      full: audits.filter((a) => a.completeness === "full").length,
      partial: audits.filter((a) => a.completeness === "partial").length,
      unavailable: audits.filter((a) => a.completeness === "unavailable").length,
      opportunities: opportunities.length,
      initiatives: plan.initiatives.length,
    },
  });

  return { report, bundle };
}

export async function getReport(id: string, workspaceId: string) {
  return prisma.intelligenceReport.findFirst({ where: { id, workspaceId } });
}

export async function listReports(workspaceId: string, limit = 20) {
  return prisma.intelligenceReport.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true, status: true, generatedAt: true, generatedBy: true,
      pdfUrl: true, createdAt: true,
    },
  });
}

function bundleOf(row: {
  auditsJson: unknown; opportunitiesJson: unknown; plan90dJson: unknown;
  auditCompletenessJson: unknown; generatedAt: Date | null;
}): ReportBundle {
  return {
    audits: (row.auditsJson ?? []) as AuditResult[],
    opportunities: (row.opportunitiesJson ?? []) as RevenueOpportunity[],
    plan: (row.plan90dJson ?? { initiatives: [], generatedAt: "" }) as GrowthPlan,
    completeness: (row.auditCompletenessJson ?? {}) as Record<AuditId, Completeness>,
    generatedAt: row.generatedAt?.toISOString() ?? "",
  };
}

export async function getReportBundle(id: string, workspaceId: string): Promise<ReportBundle | null> {
  const row = await getReport(id, workspaceId);
  return row ? bundleOf(row) : null;
}

/** Human review: draft → ready (finalize), or ready → archived. */
export async function setReportStatus(
  id: string, workspaceId: string, userId: string,
  status: "ready" | "archived",
  orderedInitiativeIds?: string[],
) {
  const row = await getReport(id, workspaceId);
  if (!row) throw new Error("Report not found in workspace.");
  if (status === "ready" && row.status !== "draft") {
    throw new Error(`Cannot finalize report in status ${row.status}.`);
  }
  let planJson = row.plan90dJson;
  if (orderedInitiativeIds && orderedInitiativeIds.length > 0) {
    const plan = bundleOf(row).plan;
    planJson = reprioritize(plan, orderedInitiativeIds) as never;
  }
  const updated = await prisma.intelligenceReport.update({
    where: { id },
    data: { status, plan90dJson: planJson as never },
  });
  await authorityAudit.logAsync({
    workspaceId, actor: userId,
    action: status === "ready" ? "intelligence_report_finalized" : "intelligence_report_archived",
    entityType: "intelligence_report", entityId: id,
    detail: { status, reprioritized: Boolean(orderedInitiativeIds?.length) },
  });
  return updated;
}

export { AUDIT_ORDER };
