// Marketr — Phase 6 I1 audit 8: Reputation.
// Review config/requests (Phase 3), ratings, velocity, sentiment distribution.

import { funnelStats, activeReviewConfig } from "@/lib/reviews/engine";
import { prisma } from "@/lib/prisma";
import type { AuditContext, AuditResult } from "../types";
import { clampScore, nowIso } from "./index";

export async function runReputationAudit(ctx: AuditContext): Promise<AuditResult> {
  const findings: AuditResult["findings"] = [];
  let signals = 0;

  let configOk = false;
  try {
    await activeReviewConfig(ctx.workspaceId);
    configOk = true;
  } catch {
    configOk = false;
  }
  if (configOk) {
    signals += 1;
    findings.push({
      severity: "info", title: "Review-request engine configured",
      detail: "QR pages and smart-timing triggers are live — the velocity engine has something to run on.",
      dataSource: "ReviewSiteConfig (Phase 3)",
    });
  } else {
    findings.push({
      severity: "warn", title: "Review-request engine not configured",
      detail: "Set up review site config so every transaction can trigger a review request at smart timing.",
      dataSource: "ReviewSiteConfig (Phase 3)",
    });
  }

  try {
    const funnel = await funnelStats(ctx.workspaceId);
    const requests = funnel.sent ?? 0;
    const received = funnel.completed ?? 0;
    if (requests > 0) {
      signals += 1;
      const rate = (received / requests) * 100;
      findings.push({
        severity: rate >= 15 ? "info" : "warn",
        title: `Review velocity: ${received} received from ${requests} requests (${rate.toFixed(1)}% conversion)`,
        detail: rate >= 15
          ? "Healthy request-to-review conversion — keep the funnel fed."
          : "Request-to-review conversion is soft — tighten smart timing (in-thread, post-transaction) and check the QR placement.",
        dataSource: "ReviewRequest funnel (Phase 3)",
      });
    } else {
      findings.push({
        severity: "info", title: "No review requests sent yet",
        detail: "The engine is ready — the first velocity trigger (CRM/POS webhook) starts the flywheel.",
        dataSource: "ReviewRequest funnel (Phase 3)",
      });
    }
  } catch {
    findings.push({
      severity: "warn", title: "Review funnel stats unavailable",
      detail: "Could not read review funnel stats — treat velocity as unknown.",
      dataSource: "ReviewRequest funnel (Phase 3)",
    });
  }

  if (ctx.projectId) {
    const summary = await prisma.reviewSummary.findFirst({
      where: { projectId: ctx.projectId },
      orderBy: { periodStart: "desc" },
      select: { avgRating: true, count: true, posCount: true, neuCount: true, negCount: true, topThemes: true },
    });
    if (summary) {
      signals += 1;
      const total = Math.max(1, summary.count);
      const negShare = (summary.negCount / total) * 100;
      findings.push({
        severity: negShare > 15 ? "critical" : negShare > 8 ? "warn" : "info",
        title: `Sentiment: ${summary.posCount} positive / ${summary.neuCount} neutral / ${summary.negCount} negative`,
        detail: negShare > 8
          ? `${negShare.toFixed(0)}% of recent reviews are negative — reply to every negative inside the approval queue before asking for more reviews.`
          : "Sentiment mix is healthy — negatives are the reply-queue priority.",
        dataSource: "ReviewSummary",
      });
    } else {
      findings.push({
        severity: "warn", title: "No review summaries computed",
        detail: "Sentiment distribution needs review-summary runs — ratings exist without a trend read.",
        dataSource: "ReviewSummary",
      });
    }
  }

  return {
    id: "reputation", name: "Reputation",
    score: signals === 0 ? null : clampScore(45 + signals * 12),
    completeness: signals >= 2 ? "full" : signals === 1 ? "partial" : "unavailable",
    findings, dataSource: "ReviewSiteConfig + ReviewRequest funnel + ReviewSummary (Phase 3)",
    computedAt: nowIso(),
  };
}
