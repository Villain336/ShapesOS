// Marketr — Phase 6 I1 audit 1: Company intelligence.
// Onboarding intake + website crawl + GBP profile data.

import { prisma } from "@/lib/prisma";
import type { AuditContext, AuditResult } from "../types";
import { clampScore, nowIso } from "./index";

export async function runCompanyAudit(ctx: AuditContext): Promise<AuditResult> {
  const findings: AuditResult["findings"] = [];
  let components = 0; // of 4 intake components present

  const client = await prisma.client.findFirst({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, brandKits: { select: { id: true, name: true, tone: true } } },
  });
  if (client) {
    components += 1;
    findings.push({
      severity: "info", title: `Client profile: ${client.name}`,
      detail: "Onboarding intake record present — the report personalizes against this client.",
      dataSource: "Client (onboarding intake)",
    });
    if (client.brandKits.length > 0) {
      components += 1;
      findings.push({
        severity: "info", title: `${client.brandKits.length} brand kit${client.brandKits.length > 1 ? "s" : ""} on file`,
        detail: client.brandKits.map((b) => b.name).slice(0, 5).join(", "),
        dataSource: "BrandKit",
      });
    } else {
      findings.push({
        severity: "warn", title: "No brand kit defined",
        detail: "Create a brand kit so report copy, PDFs, and creatives render on-brand from day one.",
        dataSource: "BrandKit",
      });
    }
  } else {
    findings.push({
      severity: "warn", title: "No client record yet",
      detail: "Add a client profile during onboarding so audits can be attributed and personalized.",
      dataSource: "Client (onboarding intake)",
    });
  }

  if (ctx.projectDomain) {
    components += 1;
    findings.push({
      severity: "info", title: `Primary domain: ${ctx.projectDomain}`,
      detail: "Domain registered to an SEO project — site crawl and ranking data flow from here.",
      dataSource: "Project.domain",
    });
  } else {
    findings.push({
      severity: "warn", title: "No primary domain",
      detail: "Create an SEO project with the business domain to unlock website, SEO, and content audits.",
      dataSource: "Project.domain",
    });
  }

  const gbp = ctx.connectors.gbp;
  if (gbp.status !== "disconnected") {
    components += 1;
    findings.push({
      severity: gbp.status === "fixture" ? "info" : "info",
      title: `Google Business Profile: ${gbp.status}`,
      detail: gbp.completenessNote,
      dataSource: "ConnectorConnection (gbp)",
    });
  } else {
    findings.push({
      severity: "warn", title: "Google Business Profile not connected",
      detail: "Connect GBP to feed company data (hours, categories, photos) into the report.",
      dataSource: "ConnectorConnection (gbp)",
    });
  }

  const connected = ctx.connectors.website.status !== "disconnected"
    || ctx.connectors.gbp.status !== "disconnected";
  return {
    id: "company", name: "Company intelligence",
    score: components === 0 ? null : clampScore(35 + components * 16),
    completeness: components >= 3 ? "full" : components > 0 ? "partial" : "unavailable",
    findings, dataSource: "Client + BrandKit + Project + ConnectorConnection",
    computedAt: nowIso(),
  };
}
