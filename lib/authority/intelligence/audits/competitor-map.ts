// Marketr — Phase 6 I1 audit 3: Competitor map.
// Competitor-gap analysis, keyword overlap (M1–M11 SEO stack).

import { prisma } from "@/lib/prisma";
import type { AuditContext, AuditResult } from "../types";
import { clampScore, nowIso } from "./index";

export async function runCompetitorMapAudit(ctx: AuditContext): Promise<AuditResult> {
  const findings: AuditResult["findings"] = [];
  if (!ctx.projectId) {
    findings.push({
      severity: "warn", title: "No SEO project",
      detail: "Create an SEO project and add competitors to map the keyword battleground.",
      dataSource: "Competitor",
    });
    return {
      id: "competitor-map", name: "Competitor map", score: null, completeness: "unavailable",
      findings, dataSource: "Competitor + CompetitorSnapshot + Keyword",
      computedAt: nowIso(),
    };
  }

  const competitors = await prisma.competitor.findMany({
    where: { projectId: ctx.projectId },
    select: { domain: true },
  });
  const snapshots = await prisma.competitorSnapshot.findMany({
    where: { projectId: ctx.projectId },
    orderBy: { capturedAt: "desc" },
    take: Math.max(competitors.length, 1) * 2,
    select: { competitorDomain: true, capturedAt: true, keywordsJson: true, mock: true },
  });
  const ownKeywords = await prisma.keyword.count({ where: { projectId: ctx.projectId } });

  const mock = snapshots.some((s) => s.mock);
  const hasData = competitors.length > 0 || snapshots.length > 0;

  if (competitors.length > 0) {
    findings.push({
      severity: "info",
      title: `${competitors.length} competitors mapped: ${competitors.map((c) => c.domain).slice(0, 6).join(", ")}${competitors.length > 6 ? "…" : ""}`,
      detail: `${snapshots.length} snapshots captured — keyword-overlap gaps feed the outreach and content engines.`,
      dataSource: "Competitor + CompetitorSnapshot",
    });
  } else {
    findings.push({
      severity: "warn", title: "No competitors added",
      detail: "Add the 3–5 domains you actually lose deals to; the gap analysis runs off their keyword footprints.",
      dataSource: "Competitor",
    });
  }
  if (ownKeywords === 0) {
    findings.push({
      severity: "warn", title: "No keyword inventory",
      detail: "Run keyword research so the overlap map has your side of the board.",
      dataSource: "Keyword",
    });
  }

  const stale = snapshots.filter((s) => Date.now() - s.capturedAt.getTime() > 30 * 86400e3).length;
  if (stale > 0) {
    findings.push({
      severity: "warn", title: `${stale} snapshot${stale > 1 ? "s" : ""} older than 30 days`,
      detail: "Re-capture competitor snapshots monthly — stale maps hide new competitor content pushes.",
      dataSource: "CompetitorSnapshot",
    });
  }

  const score = hasData ? clampScore(45 + Math.min(competitors.length, 5) * 8 - (stale > 0 ? 10 : 0)) : null;
  return {
    id: "competitor-map", name: "Competitor map",
    score,
    completeness: !hasData ? "unavailable" : mock || snapshots.length === 0 ? "partial" : "full",
    findings, dataSource: "Competitor + CompetitorSnapshot + Keyword",
    computedAt: nowIso(),
  };
}
