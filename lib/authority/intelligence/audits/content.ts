// Marketr — Phase 6 I1 audit 11: Content.
// Content engine output inventory, decay/refresh status, gap vs. competitor map.

import { prisma } from "@/lib/prisma";
import type { AuditContext, AuditResult } from "../types";
import { clampScore, nowIso } from "./index";

export async function runContentAudit(ctx: AuditContext): Promise<AuditResult> {
  const findings: AuditResult["findings"] = [];
  if (!ctx.projectId) {
    findings.push({
      severity: "warn", title: "No SEO project",
      detail: "Content inventory attaches to a project — create one to unlock this audit.",
      dataSource: "ContentItem",
    });
    return {
      id: "content", name: "Content", score: null, completeness: "unavailable",
      findings, dataSource: "ContentItem + ContentDecayFinding",
      computedAt: nowIso(),
    };
  }

  const items = await prisma.contentItem.groupBy({
    by: ["status"],
    where: { projectId: ctx.projectId },
    _count: { status: true },
  });
  const byStatus = new Map(items.map((i) => [String(i.status), i._count.status]));
  const total = [...byStatus.values()].reduce((a, b) => a + b, 0);
  const published = byStatus.get("published") ?? 0;
  const draft = (byStatus.get("draft") ?? 0) + (byStatus.get("brief") ?? 0);

  if (total === 0) {
    findings.push({
      severity: "warn", title: "No content inventory",
      detail: "The content engine hasn't produced anything for this project yet — briefs start from the keyword gaps.",
      dataSource: "ContentItem",
    });
  } else {
    findings.push({
      severity: published > 0 ? "info" : "warn",
      title: `${total} content items (${published} published, ${draft} in draft/brief)`,
      detail: draft > published
        ? "The engine is writing faster than you're shipping — publish or schedule the drafts."
        : "Healthy publish ratio — keep the engine fed with new briefs.",
      dataSource: "ContentItem",
    });

    const scored = await prisma.contentItem.count({
      where: { projectId: ctx.projectId, seoScore: { not: null } },
    });
    if (scored < published) {
      findings.push({
        severity: "info",
        title: `${published - scored} published item${published - scored === 1 ? "" : "s"} without an SEO score`,
        detail: "Re-score published content so the refresh queue is ranked by real scores, not age.",
        dataSource: "ContentItem.seoScore",
      });
    }
  }

  const openDecay = await prisma.contentDecayFinding.count({
    where: { projectId: ctx.projectId, status: "open" },
  });
  if (openDecay > 0) {
    findings.push({
      severity: openDecay > 5 ? "critical" : "warn",
      title: `${openDecay} open decay finding${openDecay > 1 ? "s" : ""}`,
      detail: "Refreshing a decaying page is cheaper than writing a new one — work the refresh queue before commissioning net-new content.",
      dataSource: "ContentDecayFinding",
    });
  } else if (total > 0) {
    findings.push({
      severity: "info", title: "No open decay findings",
      detail: "Published content is holding its positions.",
      dataSource: "ContentDecayFinding",
    });
  }

  // Gap vs competitor map: keywords without content.
  const keywordsWithoutContent = await prisma.keyword.count({
    where: { projectId: ctx.projectId, contentItems: { none: {} } },
  });
  if (keywordsWithoutContent > 0) {
    findings.push({
      severity: keywordsWithoutContent > 20 ? "warn" : "info",
      title: `${keywordsWithoutContent} researched keyword${keywordsWithoutContent > 1 ? "s" : ""} with no content`,
      detail: "These are the content engine's brief queue — ranked by the keyword scores.",
      dataSource: "Keyword + ContentItem",
    });
  }

  const score = total === 0 ? null : clampScore(45 + Math.min(30, published * 5) - Math.min(20, openDecay * 3));
  return {
    id: "content", name: "Content",
    score,
    completeness: total > 0 ? "full" : "partial",
    findings, dataSource: "ContentItem + ContentDecayFinding",
    computedAt: nowIso(),
  };
}
