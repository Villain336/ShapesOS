// Marketr — Phase 6 I1 audit 4: Website.
// Site audit (SEO stack), page-speed, mobile, CRO heuristics (new: conversion-
// focused heuristics layer). Heuristics are labeled as such — never presented
// as a real crawl of the live page unless site-audit data exists.

import { prisma } from "@/lib/prisma";
import type { AuditContext, AuditResult } from "../types";
import { clampScore, nowIso } from "./index";

// Conversion-focused heuristics evaluated against site-audit issue categories.
const CRO_HEURISTICS = [
  { category: "performance", check: "Core Web Vitals within budget", fix: "Compress hero media, defer non-critical JS, ship fonts with display:swap." },
  { category: "mobile", check: "Mobile-first layout + tap targets", fix: "Verify 44px+ tap targets and no horizontal scroll on key pages." },
  { category: "trust", check: "Above-the-fold trust signals", fix: "Reviews count, badges, and guarantee visible without scrolling." },
  { category: "cta", check: "Single dominant CTA per viewport", fix: "One primary action per screen; secondary actions de-emphasized." },
  { category: "forms", check: "Lead forms ≤ 5 fields", fix: "Every extra field costs ~10% of submissions — ask only what's needed." },
  { category: "speed", check: "LCP under 2.5s on key pages", fix: "Preload hero assets; move third-party scripts behind consent." },
];

export async function runWebsiteAudit(ctx: AuditContext): Promise<AuditResult> {
  const findings: AuditResult["findings"] = [];
  if (!ctx.projectId) {
    findings.push({
      severity: "warn", title: "No SEO project",
      detail: "Site audits attach to a project — create one to unlock the website audit.",
      dataSource: "SiteAudit",
    });
    return {
      id: "website", name: "Website", score: null, completeness: "unavailable",
      findings, dataSource: "SiteAudit + SiteIssue (CRO heuristics layer)",
      computedAt: nowIso(),
    };
  }

  const audit = await prisma.siteAudit.findFirst({
    where: { projectId: ctx.projectId },
    orderBy: { startedAt: "desc" },
    include: { issues: { select: { severity: true, category: true } } },
  });

  if (!audit) {
    findings.push({
      severity: "warn", title: "No site audit on record",
      detail: "Run a site audit to get issue-level findings; the CRO heuristics below are general guidance until then.",
      dataSource: "SiteAudit",
    });
  } else {
    const errorCount = audit.issues.filter((i) => String(i.severity).toLowerCase() === "error").length;
    findings.push({
      severity: errorCount > 0 ? "critical" : audit.openIssues > 0 ? "warn" : "info",
      title: `Latest audit: ${audit.openIssues} open issues (${errorCount} errors)`,
      detail: audit.finishedAt
        ? `Finished ${audit.finishedAt.toISOString().slice(0, 10)} — ${audit.totalIssues} total issues found.`
        : "Audit still running — numbers below reflect its latest snapshot.",
      dataSource: "SiteAudit",
    });
    if (audit.mock) {
      findings.push({
        severity: "info", title: "Audit data is a labeled mock",
        detail: "This audit ran in mock mode — treat findings as directional until a real crawl runs.",
        dataSource: "SiteAudit",
      });
    }
  }

  // CRO heuristics layer: labeled as guidance, scored from issue categories when present.
  const categories = new Set((audit?.issues ?? []).map((i) => i.category));
  for (const h of CRO_HEURISTICS) {
    findings.push({
      severity: audit && categories.has(h.category) ? "warn" : "info",
      title: h.check,
      detail: h.fix,
      dataSource: "I1 CRO heuristics layer (guidance, not a live crawl)",
    });
  }

  const score = audit
    ? clampScore(72 - audit.openIssues * 2)
    : null;
  return {
    id: "website", name: "Website",
    score,
    completeness: audit ? (audit.mock ? "partial" : "full") : "partial",
    findings, dataSource: "SiteAudit + SiteIssue (CRO heuristics layer)",
    computedAt: nowIso(),
  };
}
