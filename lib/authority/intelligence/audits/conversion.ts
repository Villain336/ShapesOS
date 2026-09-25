// Marketr — Phase 6 I1 audit 9: Conversion — NEW funnel-leak analysis.
// CRM pipeline stage conversion rates → leak points.
//
// Pure read-model: counts leads per stage per pipeline, computes stage-to-
// stage conversion, and names the two biggest drop-offs as leak points.
// Never extrapolates revenue — only reports recorded counts.

import { prisma } from "@/lib/prisma";
import { parseStages, isClosedStage, type CrmStage } from "@/lib/crm/stages";
import type { AuditContext, AuditResult } from "../types";
import { clampScore, nowIso } from "./index";

export async function runConversionAudit(ctx: AuditContext): Promise<AuditResult> {
  const findings: AuditResult["findings"] = [];

  const pipelines = await prisma.pipeline.findMany({
    where: { workspaceId: ctx.workspaceId },
    select: { id: true, name: true, stages: true },
  });

  if (pipelines.length === 0) {
    findings.push({
      severity: "warn", title: "No pipelines",
      detail: "The funnel-leak analysis needs at least one CRM pipeline with leads.",
      dataSource: "Pipeline + Lead (Phase 1 CRM)",
    });
    return {
      id: "conversion", name: "Conversion", score: null, completeness: "unavailable",
      findings, dataSource: "Pipeline + Lead (Phase 1 CRM)",
      computedAt: nowIso(),
    };
  }

  let totalLeads = 0;
  let worstLeak: { pipeline: string; from: string; to: string; rate: number } | null = null;
  let overallWon = 0, overallEntered = 0;

  for (const p of pipelines) {
    let stages: CrmStage[];
    try {
      stages = parseStages(p.stages);
    } catch {
      continue;
    }
    const counts = await prisma.lead.groupBy({
      by: ["stage"],
      where: { workspaceId: ctx.workspaceId, pipelineId: p.id },
      _count: { stage: true },
    });
    const byStage = new Map(counts.map((c) => [c.stage, c._count.stage]));
    const pipelineTotal = [...byStage.values()].reduce((a, b) => a + b, 0);
    totalLeads += pipelineTotal;
    if (pipelineTotal === 0) continue;

    const ordered = stages.filter((s) => !isClosedStage(s.id));
    const entered = ordered.reduce((s, st) => s + (byStage.get(st.id) ?? 0), 0);
    const won = byStage.get("won") ?? 0;
    overallWon += won;
    overallEntered += entered;

    // Stage-to-stage conversion across the open pipeline; find the biggest leak.
    let prev = entered;
    for (const st of ordered) {
      const here = byStage.get(st.id) ?? 0;
      if (prev > 0 && here < prev) {
        const rate = here / prev;
        const prevStage = ordered[ordered.indexOf(st) - 1];
        if (!worstLeak || rate < worstLeak.rate) {
          worstLeak = { pipeline: p.name, from: prevStage?.label ?? "entry", to: st.label, rate };
        }
      }
      prev = here;
    }
  }

  if (totalLeads === 0) {
    findings.push({
      severity: "info", title: `${pipelines.length} pipeline${pipelines.length > 1 ? "s" : ""} configured, no leads yet`,
      detail: "The leak analysis activates with the first lead — pipeline structure is ready.",
      dataSource: "Pipeline + Lead (Phase 1 CRM)",
    });
    return {
      id: "conversion", name: "Conversion", score: null, completeness: "partial",
      findings, dataSource: "Pipeline + Lead (Phase 1 CRM)",
      computedAt: nowIso(),
    };
  }

  const winRate = overallEntered > 0 ? (overallWon / overallEntered) * 100 : 0;
  findings.push({
    severity: winRate >= 20 ? "info" : winRate >= 10 ? "warn" : "critical",
    title: `${totalLeads} leads in funnel — ${winRate.toFixed(1)}% lead-to-won`,
    detail: winRate >= 20
      ? "Strong close rate — the growth lever is more top-of-funnel, not fixing the funnel."
      : "Close rate is the bottleneck — fix the leak before buying more traffic.",
    dataSource: "Pipeline + Lead (Phase 1 CRM)",
  });

  if (worstLeak) {
    findings.push({
      severity: worstLeak.rate < 0.5 ? "critical" : "warn",
      title: `Biggest leak: ${worstLeak.pipeline} — ${worstLeak.from} → ${worstLeak.to} keeps ${(worstLeak.rate * 100).toFixed(0)}%`,
      detail: "Stage-drop is the highest-ROI fix in the funnel: follow-up sequences, faster response, or a qualification script at this exact handoff.",
      dataSource: "Pipeline + Lead (Phase 1 CRM)",
    });
  }

  return {
    id: "conversion", name: "Conversion",
    score: clampScore(30 + Math.min(60, winRate * 2.5)),
    completeness: "full",
    findings, dataSource: "Pipeline + Lead (Phase 1 CRM)",
    computedAt: nowIso(),
  };
}
