// Marketr — fix-agent scheduled-run orchestration (milestone 10).
//
// Eligibility rule (the trust ladder, enforced in ONE place):
//   an issue may be auto-fixed on schedule iff
//     - the fix agent is enabled for the site, AND
//     - the issue is autoFixable (strategy != manual), AND
//     - (the issue was explicitly approved per-issue) OR
//       (its category is in settings.allowedCategories AND it is NOT destructive).
// Destructive categories ALWAYS need explicit per-issue approval.
//
// Dry-run mode generates diffs and stores them on the issue for review —
// nothing is written. Live mode snapshots every touched file first (rollback),
// applies fixes, audit-logs each one (actor: fix_agent), then re-scans the
// touched files to verify.

import { promises as fs } from "fs";
import { join } from "path";
import { prisma } from "@/lib/prisma";
import type { SiteFileProvider } from "@/lib/sitefiles/types";
import { getLlmProvider } from "@/lib/llm";
import { CATEGORY_MAP } from "./categories";
import { scanSite } from "./scanner";
import { planFix } from "./fixer";

const SNAPSHOT_ROOT =
  process.env.FIX_SNAPSHOT_DIR?.trim() || join(process.cwd(), ".data", "fix-snapshots");

export interface RunInput {
  siteId: string;
  projectId: string;
  /** Auth user id for FileChangeLog.approvedBy (cron passes "schedule"). */
  approvedBy: string;
  provider: SiteFileProvider;
  /** Override settings (tests). When omitted, settings are loaded from the DB. */
  settingsOverride?: {
    enabled: boolean;
    allowedCategories: string[];
    maxFixesPerRun: number;
    dryRun: boolean;
  };
}

export interface RunResult {
  runId: string;
  dryRun: boolean;
  eligible: number;
  applied: number;
  previews: number;
  skipped: number;
  issues: { id: string; category: string; status: string; summary?: string }[];
  summary: string;
}

async function snapshotPath(runId: string): Promise<string> {
  await fs.mkdir(SNAPSHOT_ROOT, { recursive: true });
  return join(SNAPSHOT_ROOT, `${runId}.json`);
}

export async function saveSnapshot(runId: string, files: Record<string, string>): Promise<string> {
  const path = await snapshotPath(runId);
  await fs.writeFile(path, JSON.stringify({ runId, files }), "utf8");
  return runId;
}

export async function loadSnapshot(runId: string): Promise<Record<string, string>> {
  const path = await snapshotPath(runId);
  const raw = JSON.parse(await fs.readFile(path, "utf8")) as { files: Record<string, string> };
  return raw.files ?? {};
}

export function isIssueEligible(
  issue: { status: string; category: string; autoFixable: boolean; destructive: boolean },
  settings: { enabled: boolean; allowedCategories: string[] },
): boolean {
  if (!settings.enabled) return false;
  if (!issue.autoFixable) return false;
  if (issue.status === "approved") return true; // explicit per-issue approval always counts
  if (issue.status !== "open") return false;
  if (issue.destructive) return false; // destructive needs per-issue approval, always
  return settings.allowedCategories.includes(issue.category);
}

export async function runScheduledFixes(input: RunInput): Promise<RunResult> {
  const { siteId, projectId, approvedBy, provider } = input;

  const settings =
    input.settingsOverride ??
    (await prisma.fixAgentSettings.upsert({
      where: { siteId },
      update: {},
      create: { siteId },
    }));

  const run = await prisma.fixRun.create({
    data: {
      projectId,
      siteId,
      mode: "scheduled",
      status: "running",
      reportSummary: settings.dryRun ? "dry-run" : "live",
    },
  });

  const issues = await prisma.siteIssue.findMany({
    where: { siteId, status: { in: ["open", "approved"] } },
    orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
    take: settings.maxFixesPerRun * 3, // fetch headroom, then cap
  });

  const eligible = issues.filter((i) => isIssueEligible(i, settings)).slice(0, settings.maxFixesPerRun);
  const skipped = issues.length - eligible.length;

  const llm = getLlmProvider();
  const snapshotFiles: Record<string, string> = {};
  const touched = new Set<string>();
  const results: RunResult["issues"] = [];
  let applied = 0;
  let previews = 0;

  // For sitemap generation we need the page list up front.
  let sitePages: string[] = [];
  if (eligible.some((i) => i.category === "missing-robots-sitemap")) {
    try {
      const { collectAllFiles } = await import("@/lib/connectors/source");
      sitePages = (await collectAllFiles(provider)).filter((p) => /\.(html?)$/i.test(p));
    } catch {
      sitePages = [];
    }
  }

  for (const issue of eligible) {
    await prisma.siteIssue.update({ where: { id: issue.id }, data: { status: "fixing" } });
    try {
      let current: string | null = null;
      if (issue.filePath !== "/") {
        try {
          current = (await provider.readFile(issue.filePath)).content;
        } catch {
          current = null;
        }
      }
      const plan = await planFix(issue.category, issue.filePath, current, llm, sitePages);

      if (settings.dryRun) {
        // Propose only: store the preview, leave the issue approved/open.
        await prisma.siteIssue.update({
          where: { id: issue.id },
          data: { status: issue.status === "approved" ? "approved" : "open", proposedDiff: plan.preview },
        });
        previews++;
        results.push({ id: issue.id, category: issue.category, status: "dry-run", summary: plan.summary });
        continue;
      }

      // Live: snapshot, apply, audit-log.
      const targets: Record<string, string> = {};
      if (plan.newContent !== null && issue.filePath !== "/") targets[issue.filePath] = plan.newContent;
      Object.assign(targets, plan.extraFiles);
      for (const [p, next] of Object.entries(targets)) {
        if (!(p in snapshotFiles)) {
          try {
            snapshotFiles[p] = (await provider.readFile(p)).content;
          } catch {
            snapshotFiles[p] = ""; // new file — revert deletes it
          }
        }
        await provider.writeFile(p, next);
        touched.add(p);
      }

      for (const p of Object.keys(targets)) {
        await prisma.fileChangeLog.create({
          data: {
            projectId,
            siteId,
            filePath: p,
            actor: "fix_agent",
            action: "fix_applied",
            summary: `Fix agent applied approved fix (${issue.category}): ${plan.summary}`,
            approvedBy,
          },
        });
      }

      await prisma.siteIssue.update({
        where: { id: issue.id },
        data: { status: "fixed", fixedAt: new Date(), fixRunId: run.id, proposedDiff: plan.preview },
      });
      applied++;
      results.push({ id: issue.id, category: issue.category, status: "fixed", summary: plan.summary });
    } catch (err) {
      // Leave the issue open so it can be retried; the run continues.
      await prisma.siteIssue.update({ where: { id: issue.id }, data: { status: "open" } });
      results.push({
        id: issue.id,
        category: issue.category,
        status: "failed",
        summary: err instanceof Error ? err.message : "fix failed",
      });
    }
  }

  // Persist the pre-change snapshot for rollback (live runs only).
  if (!settings.dryRun && Object.keys(snapshotFiles).length > 0) {
    await saveSnapshot(run.id, snapshotFiles);
    await prisma.fixRun.update({ where: { id: run.id }, data: { snapshotRef: run.id } });
  }

  // Verify: re-scan the touched files; mark issues verified when their
  // category no longer appears for the same file.
  if (!settings.dryRun && touched.size > 0) {
    try {
      const fresh = await scanSite(provider);
      const remaining = new Set(fresh.map((f) => `${f.category}::${f.filePath}`));
      const fixedIssues = await prisma.siteIssue.findMany({
        where: { fixRunId: run.id, status: "fixed" },
      });
      for (const fi of fixedIssues) {
        if (!remaining.has(`${fi.category}::${fi.filePath}`)) {
          await prisma.siteIssue.update({ where: { id: fi.id }, data: { status: "verified" } });
          const r = results.find((x) => x.id === fi.id);
          if (r) r.status = "verified";
        }
      }
    } catch {
      // Verification is best-effort; fixed status stands.
    }
  }

  const summary = settings.dryRun
    ? `Dry run: ${previews} fix preview${previews === 1 ? "" : "s"} generated for review, nothing applied.`
    : `Applied ${applied} fix${applied === 1 ? "" : "es"} (${results.filter((r) => r.status === "verified").length} verified by re-scan).`;

  await prisma.fixRun.update({
    where: { id: run.id },
    data: { status: "completed", fixesApplied: applied, reportSummary: summary },
  });

  return {
    runId: run.id,
    dryRun: settings.dryRun,
    eligible: eligible.length,
    applied,
    previews,
    skipped,
    issues: results,
    summary,
  };
}

/** One-click revert of a fix-agent run: restore every snapshotted file. */
export async function revertFixRun(input: {
  siteId: string;
  projectId: string;
  runId: string;
  provider: SiteFileProvider;
  approvedBy: string;
}): Promise<{ restored: string[]; deleted: string[] }> {
  const { siteId, projectId, runId, provider, approvedBy } = input;
  const run = await prisma.fixRun.findFirst({
    where: { id: runId, siteId, projectId, mode: "scheduled" },
  });
  if (!run) throw new Error("Fix run not found");
  if (!run.snapshotRef) throw new Error("This run has no snapshot to revert (dry run or nothing was written)");

  const files = await loadSnapshot(run.id);
  const restored: string[] = [];
  const deleted: string[] = [];

  // LocalDirProvider has no delete; restore by writing previous content.
  // Files that didn't exist before (snapshot "") are emptied — the audit log
  // records the revert and the user can remove them in the IDE.
  for (const [p, before] of Object.entries(files)) {
    await provider.writeFile(p, before);
    if (before === "") deleted.push(p);
    else restored.push(p);
    await prisma.fileChangeLog.create({
      data: {
        projectId,
        siteId,
        filePath: p,
        actor: "fix_agent",
        action: "fix_reverted",
        summary: `Reverted fix-agent run ${run.id.slice(0, 8)}: restored pre-change content`,
        approvedBy,
      },
    });
  }

  const revertedIssues = await prisma.siteIssue.findMany({
    where: { fixRunId: run.id, status: { in: ["fixed", "verified"] } },
  });
  for (const fi of revertedIssues) {
    await prisma.siteIssue.update({
      where: { id: fi.id },
      data: { status: "open", fixedAt: null, fixRunId: null },
    });
  }

  await prisma.fixRun.update({
    where: { id: run.id },
    data: { status: "rolled_back", reportSummary: `${run.reportSummary ?? ""} [reverted]` },
  });

  return { restored, deleted };
}

export { CATEGORY_MAP };
