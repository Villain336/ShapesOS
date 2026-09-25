// Marketr — Phase 6 I1 audit 2: Market position.
// Competitor radar + review ratings vs. competitors (Phase 0–2).

import { prisma } from "@/lib/prisma";
import type { AuditContext, AuditResult } from "../types";
import { clampScore, nowIso } from "./index";

export async function runMarketAudit(ctx: AuditContext): Promise<AuditResult> {
  const findings: AuditResult["findings"] = [];
  let components = 0;

  if (ctx.projectId) {
    const localCompetitors = await prisma.localCompetitor.findMany({
      where: { projectId: ctx.projectId, enabled: true },
      select: { id: true, businessName: true, lastSnapshotAt: true },
    });
    if (localCompetitors.length > 0) {
      components += 1;
      findings.push({
        severity: "info",
        title: `${localCompetitors.length} local competitors tracked`,
        detail: localCompetitors.map((c) => c.businessName).slice(0, 8).join(", "),
        dataSource: "LocalCompetitor",
      });
    } else {
      findings.push({
        severity: "warn", title: "No local competitors tracked",
        detail: "Add local competitors in the competitor radar to benchmark market position.",
        dataSource: "LocalCompetitor",
      });
    }

    const ownSummary = await prisma.reviewSummary.findFirst({
      where: { projectId: ctx.projectId },
      orderBy: { periodStart: "desc" },
      select: { avgRating: true, count: true, posCount: true, negCount: true },
    });
    if (ownSummary?.avgRating != null) {
      components += 1;
      const neg = ownSummary.negCount;
      findings.push({
        severity: ownSummary.avgRating >= 4.3 ? "info" : ownSummary.avgRating >= 3.8 ? "warn" : "critical",
        title: `Rating position: ${ownSummary.avgRating.toFixed(1)}★ across ${ownSummary.count} reviews`,
        detail: neg > 0
          ? `${neg} negative review${neg > 1 ? "s" : ""} in the latest period — ratings are a tiebreaker when price and location are equal.`
          : "Clean recent rating profile — leverage it in ad copy and listing descriptions.",
        dataSource: "ReviewSummary",
      });
    } else {
      findings.push({
        severity: "warn", title: "No review-summary data",
        detail: "Review summaries are not yet computed for this project — reputation data will be sparse.",
        dataSource: "ReviewSummary",
      });
    }

    const radarEvents = await prisma.competitorRadarEvent.count({
      where: { project: { id: ctx.projectId } },
    }).catch(() => 0);
    if (radarEvents > 0) {
      components += 1;
      findings.push({
        severity: "info", title: `Competitor radar: ${radarEvents} tracked events`,
        detail: "Radar events feed move-by-move market-position awareness.",
        dataSource: "CompetitorRadarEvent",
      });
    }
  }

  const score = components === 0 ? null : clampScore(30 + components * 18);
  return {
    id: "market", name: "Market position",
    score,
    completeness: components >= 2 ? "full" : components === 1 ? "partial" : "unavailable",
    findings, dataSource: "LocalCompetitor + ReviewSummary + CompetitorRadarEvent",
    computedAt: nowIso(),
  };
}
