// Marketr — Phase 6 I1 audit 10: CRM.
// Pipeline health, nurture sequence coverage, speed-to-lead (Phases 1, 3).

import { prisma } from "@/lib/prisma";
import type { AuditContext, AuditResult } from "../types";
import { clampScore, nowIso } from "./index";

export async function runCrmAudit(ctx: AuditContext): Promise<AuditResult> {
  const findings: AuditResult["findings"] = [];
  let signals = 0;

  const pipelines = await prisma.pipeline.findMany({
    where: { workspaceId: ctx.workspaceId },
    select: { id: true, name: true },
  });
  if (pipelines.length > 0) {
    signals += 1;
    findings.push({
      severity: "info",
      title: `${pipelines.length} pipeline${pipelines.length > 1 ? "s" : ""} live`,
      detail: pipelines.map((p) => p.name).slice(0, 6).join(", "),
      dataSource: "Pipeline (Phase 1 CRM)",
    });
  } else {
    findings.push({
      severity: "warn", title: "No CRM pipelines",
      detail: "Create a pipeline so leads have somewhere to flow and convert.",
      dataSource: "Pipeline (Phase 1 CRM)",
    });
  }

  // Speed-to-lead: median minutes from lead creation to first stage move.
  // The Lead model carries createdAt; stage moves are not individually
  // timestamped, so we report coverage + a proxy: leads still in "new".
  const staleNew = await prisma.lead.count({
    where: {
      workspaceId: ctx.workspaceId, stage: "new",
      createdAt: { lt: new Date(Date.now() - 24 * 3600e3) },
    },
  });
  if (staleNew > 0) {
    findings.push({
      severity: staleNew > 10 ? "critical" : "warn",
      title: `${staleNew} lead${staleNew > 1 ? "s" : ""} untouched in "new" for 24h+`,
      detail: "Speed-to-lead is the highest-leverage CRM metric — every hour of delay measurably drops close rate. Triage these today.",
      dataSource: "Lead.createdAt (speed-to-lead proxy)",
    });
  } else {
    signals += 1;
    findings.push({
      severity: "info", title: "No stale leads in \"new\"",
      detail: "Every lead created in the last 24h has moved past intake — speed-to-lead is healthy.",
      dataSource: "Lead.createdAt (speed-to-lead proxy)",
    });
  }

  const sequences = await prisma.nurtureSequence.findMany({
    where: { workspaceId: ctx.workspaceId },
    select: { id: true, name: true, status: true, steps: true },
  });
  const activeSeq = sequences.filter((s) => s.status === "active");
  if (activeSeq.length > 0) {
    signals += 1;
    findings.push({
      severity: "info",
      title: `${activeSeq.length} active nurture sequence${activeSeq.length > 1 ? "s" : ""}`,
      detail: activeSeq.map((s) => s.name).slice(0, 5).join(", "),
      dataSource: "NurtureSequence (Phase 3)",
    });
  } else if (sequences.length > 0) {
    findings.push({
      severity: "warn",
      title: `${sequences.length} nurture sequence${sequences.length > 1 ? "s" : ""} drafted but none active`,
      detail: "Drafts don't nurture — activate the sequences so stalled leads get follow-up automatically.",
      dataSource: "NurtureSequence (Phase 3)",
    });
  } else {
    findings.push({
      severity: "warn", title: "No nurture sequences",
      detail: "Build at least one nurture sequence so non-ready leads stay warm instead of going cold.",
      dataSource: "NurtureSequence (Phase 3)",
    });
  }

  return {
    id: "crm", name: "CRM",
    score: signals === 0 ? null : clampScore(50 + signals * 10 - (staleNew > 10 ? 15 : 0)),
    completeness: signals >= 2 ? "full" : signals === 1 ? "partial" : "unavailable",
    findings, dataSource: "Pipeline + Lead + NurtureSequence (Phases 1, 3)",
    computedAt: nowIso(),
  };
}
