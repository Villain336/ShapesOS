// Marketr — Phase 6 I1: audit runner + shared audit helpers.
//
// The registry order here IS the report order (SPEC-PHASE6 §2/I1, audits 1–12).

import type {
  AuditContext, AuditId, AuditResult, Completeness, ReportBundle,
} from "../types";
import { AUDIT_NAMES, AUDIT_ORDER } from "../types";
import { runCompanyAudit } from "./company";
import { runMarketAudit } from "./market";
import { runCompetitorMapAudit } from "./competitor-map";
import { runWebsiteAudit } from "./website";
import { runBrandAudit } from "./brand";
import { runSeoAudit } from "./seo";
import { runPaidAudit } from "./paid";
import { runReputationAudit } from "./reputation";
import { runConversionAudit } from "./conversion";
import { runCrmAudit } from "./crm";
import { runContentAudit } from "./content";
import { runTechAudit } from "./tech";

const RUNNERS: Record<AuditId, (ctx: AuditContext) => Promise<AuditResult>> = {
  "company": runCompanyAudit,
  "market": runMarketAudit,
  "competitor-map": runCompetitorMapAudit,
  "website": runWebsiteAudit,
  "brand": runBrandAudit,
  "seo": runSeoAudit,
  "paid": runPaidAudit,
  "reputation": runReputationAudit,
  "conversion": runConversionAudit,
  "crm": runCrmAudit,
  "content": runContentAudit,
  "technology": runTechAudit,
};

/** Run all twelve audits in order; every audit degrades to partial/unavailable. */
export async function runAllAudits(ctx: AuditContext): Promise<AuditResult[]> {
  const results: AuditResult[] = [];
  for (const id of AUDIT_ORDER) {
    try {
      results.push(await RUNNERS[id](ctx));
    } catch (err) {
      // An audit that throws degrades to unavailable — it never blocks the report.
      results.push({
        id, name: AUDIT_NAMES[id], score: null, completeness: "unavailable",
        findings: [{
          severity: "warn", title: "Audit could not run",
          detail: `The ${AUDIT_NAMES[id].toLowerCase()} audit failed: ${err instanceof Error ? err.message : String(err)}. Treat this section as unavailable until the data source is healthy.`,
          dataSource: "intelligence-report-runner",
        }],
        dataSource: "intelligence-report-runner",
        computedAt: new Date().toISOString(),
      });
    }
  }
  return results;
}

/** Merge connector presence + row counts into a completeness label. */
export function completenessFor(opts: {
  connectorsReady: boolean;
  hasData: boolean;
  fixtureOnly: boolean;
}): Completeness {
  if (!opts.hasData || !opts.connectorsReady) return "unavailable";
  if (opts.fixtureOnly) return "partial";
  return "full";
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Clamp a heuristic score to 0–100, rounded. */
export function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
