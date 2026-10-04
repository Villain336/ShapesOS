// Marketr — audit execution: scan → persist SiteAudit + SiteIssue rows (milestone 10).

import { prisma } from "@/lib/prisma";
import type { SiteFileProvider } from "@/lib/sitefiles/types";
import { CATEGORY_MAP } from "./categories";
import { scanSite } from "./scanner";
import { mockScanFindings } from "./mock";
import { meter } from "@/lib/metering/service";

export interface AuditInput {
  siteId: string;
  projectId: string;
  siteName: string;
  provider: SiteFileProvider | null; // null when mocking
  mock: boolean;
  /** Skip the site_audit ledger entry: only for callers that already
   *  charged this exact action before running (the MCP runner meters
   *  site_audit per call — charging here too would bill twice, T14). */
  skipMetering?: boolean;
}

export async function runAudit(input: AuditInput) {
  const { siteId, projectId, siteName, provider, mock } = input;

  const audit = await prisma.siteAudit.create({
    data: { siteId, projectId, status: "running", mock },
  });

  try {
    const findings = mock || !provider ? mockScanFindings(siteName) : await scanSite(provider);

    // Supersede previous actionable issues — the inbox always reflects the
    // latest audit. History stays in the DB via older audit rows.
    await prisma.siteIssue.updateMany({
      where: { siteId, status: { in: ["open", "approved"] } },
      data: { status: "ignored" },
    });

    const rows = await Promise.all(
      findings.map((f) => {
        const cat = CATEGORY_MAP[f.category];
        return prisma.siteIssue.create({
          data: {
            siteId,
            projectId,
            auditId: audit.id,
            category: f.category,
            severity: cat?.defaultSeverity ?? "info",
            filePath: f.filePath,
            line: f.line,
            detail: f.detail,
            fixHint: f.fixHint,
            autoFixable: f.autoFixable,
            destructive: cat?.destructive ?? false,
            status: "open",
          },
        });
      }),
    );

    const errorIssues = rows.filter((r) => r.severity === "error" || r.severity === "critical").length;
    const done = await prisma.siteAudit.update({
      where: { id: audit.id },
      data: {
        status: "completed",
        finishedAt: new Date(),
        totalIssues: rows.length,
        openIssues: rows.length,
        errorIssues,
      },
    });

    // Phase C gaps (G1): ledger one site_audit per crawl. The audit row is
    // the domain row. workspaceId is resolved from the project row — never
    // from the caller (T10). Covers the API route and the chat audit tool,
    // which both funnel through runAudit.
    const proj = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    if (proj && !input.skipMetering) {
      await meter({
        workspaceId: proj.workspaceId,
        projectId,
        action: "site_audit",
        idempotencyKey: `siteaudit:${done.id}`,
        evidenceRef: `site-audit:${done.id}`,
      }).catch((err) => {
        console.error(`Metering failed for site audit ${done.id}:`, err);
      });
    }

    return { audit: done, issues: rows };
  } catch (err) {
    await prisma.siteAudit.update({
      where: { id: audit.id },
      data: { status: "failed", finishedAt: new Date() },
    });
    throw err;
  }
}

/** Latest audit + its actionable issues + settings for a site (inbox payload). */
export async function getAuditInbox(siteId: string) {
  const [settings, latestAudit, issues, fixRuns] = await Promise.all([
    prisma.fixAgentSettings.upsert({
      where: { siteId },
      update: {},
      create: { siteId },
    }),
    prisma.siteAudit.findFirst({
      where: { siteId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.siteIssue.findMany({
      where: { siteId, status: { in: ["open", "approved", "fixing", "fixed"] } },
      orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
      take: 500,
    }),
    prisma.fixRun.findMany({
      where: { siteId },
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
  ]);
  return { settings, latestAudit, issues, fixRuns };
}
