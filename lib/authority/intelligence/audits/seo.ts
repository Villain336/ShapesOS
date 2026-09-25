// Marketr — Phase 6 I1 audit 6: SEO.
// Keyword research, rankings, content decay engine, AI visibility tracking (M1–M11).

import { prisma } from "@/lib/prisma";
import type { AuditContext, AuditResult } from "../types";
import { clampScore, nowIso } from "./index";

export async function runSeoAudit(ctx: AuditContext): Promise<AuditResult> {
  const findings: AuditResult["findings"] = [];
  if (!ctx.projectId) {
    findings.push({
      severity: "warn", title: "No SEO project",
      detail: "SEO audits need a project with tracked keywords — create one to unlock this section.",
      dataSource: "Keyword + Ranking",
    });
    return {
      id: "seo", name: "SEO", score: null, completeness: "unavailable",
      findings, dataSource: "Keyword + Ranking + ContentDecayFinding",
      computedAt: nowIso(),
    };
  }

  const keywords = await prisma.keyword.findMany({
    where: { projectId: ctx.projectId },
    select: {
      id: true, phrase: true, tracked: true,
      rankings: { orderBy: { checkedAt: "desc" }, take: 1, select: { position: true, aiOverviewPresent: true } },
    },
  });
  const tracked = keywords.filter((k) => k.tracked);
  const ranked = tracked.filter((k) => k.rankings[0]?.position != null);
  const positions = ranked.map((k) => k.rankings[0]!.position as number);
  const avgPos = positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length : null;
  const top10 = ranked.filter((k) => (k.rankings[0]!.position as number) <= 10).length;
  const aio = tracked.filter((k) => k.rankings[0]?.aiOverviewPresent).length;

  if (keywords.length === 0) {
    findings.push({
      severity: "warn", title: "No keywords researched",
      detail: "Run keyword research first — rankings, decay, and gap analysis all hang off the keyword inventory.",
      dataSource: "Keyword",
    });
  } else {
    findings.push({
      severity: tracked.length > 0 ? "info" : "warn",
      title: `${keywords.length} keywords researched, ${tracked.length} tracked`,
      detail: tracked.length > 0
        ? "Tracking coverage is in place."
        : "Keywords exist but none are tracked — enable tracking to watch positions move.",
      dataSource: "Keyword",
    });
  }

  if (avgPos != null) {
    findings.push({
      severity: avgPos <= 10 ? "info" : avgPos <= 20 ? "warn" : "critical",
      title: `Average position ${avgPos.toFixed(1)} across ${ranked.length} ranked keywords (${top10} in top 10)`,
      detail: avgPos <= 10
        ? "Solid visibility — defend page-one positions with refresh cycles."
        : "Most tracked keywords sit past page one — the content engine's briefs should target position 4–15 movers first.",
      dataSource: "Ranking",
    });
  }

  if (aio > 0) {
    findings.push({
      severity: "warn",
      title: `AI Overviews present on ${aio} tracked keyword${aio > 1 ? "s" : ""}`,
      detail: "AIO coverage is eroding click share on these queries — the AEO track (Phase 6 A1) measures brand presence inside them.",
      dataSource: "Ranking.aiOverviewPresent",
    });
  }

  const decay = await prisma.contentDecayFinding.findMany({
    where: { projectId: ctx.projectId, status: "open" },
    orderBy: { decayScore: "desc" },
    take: 5,
    select: { url: true, decayScore: true, severity: true, suggestedAction: true },
  });
  if (decay.length > 0) {
    findings.push({
      severity: decay.some((d) => d.severity === "critical") ? "critical" : "warn",
      title: `${decay.length} decaying page${decay.length > 1 ? "s" : ""} need refresh`,
      detail: decay.slice(0, 3).map((d) => `${d.url ?? "unknown URL"} (decay ${(d.decayScore * 100).toFixed(0)}%)`).join("; "),
      dataSource: "ContentDecayFinding",
    });
  } else if (keywords.length > 0) {
    findings.push({
      severity: "info", title: "No open decay findings",
      detail: "The decay engine sees no pages sliding — keep the refresh cadence anyway.",
      dataSource: "ContentDecayFinding",
    });
  }

  const score = keywords.length === 0 ? null
    : clampScore(40 + (avgPos != null ? Math.max(0, 40 - avgPos * 1.5) : 0) + (decay.length === 0 ? 15 : 0));
  return {
    id: "seo", name: "SEO",
    score,
    completeness: keywords.length > 0 && tracked.length > 0 ? "full" : keywords.length > 0 ? "partial" : "unavailable",
    findings, dataSource: "Keyword + Ranking + ContentDecayFinding",
    computedAt: nowIso(),
  };
}
