// Marketr — backlink pull service (milestone 15).
//
// The ONLY sanctioned path to spend DataForSEO Backlinks credits. Every pull
// (manual refresh, scheduled cron) goes through runBacklinkPull(), which
// enforces, in order:
//   1. Hard row cap (MAX_BACKLINK_ROWS_PER_PULL) — requested over the cap is
//      rejected, never silently clamped, so the UI can show the real limit.
//   2. Workspace monthly spend cap (DEFAULT or workspace-set) — a pull whose
//      estimate would exceed the remaining budget is rejected before any
//      paid API call is made.
//   3. Cost preview — previewBacklinkPull() returns the exact estimate the
//      user must confirm in the UI cost modal.
// Every preview and every pull (including rejections) writes a BacklinkPull
// row with its cost, plus a fileChangeLog audit event.
//
// Lost-link detection: previously-active backlinks absent from a *complete*
// pull (rows returned >= provider's profile total) are marked lost. When the
// pull can't cover the whole profile (large link graph, small limit), lost
// marking is skipped — marking links lost from a partial pull would be wrong.

import { prisma } from "@/lib/prisma";
import { getSeoProvider } from "@/lib/providers";
import type { BacklinkItem, SeoDataProvider } from "@/lib/providers/types";
import { emitAlert } from "@/lib/alerts/evaluate";
import {
  DEFAULT_MONTHLY_SPEND_CAP_USD,
  MAX_BACKLINK_ROWS_PER_PULL,
  checkPullBudget,
  estimateListPullCost,
  estimateSummaryPullCost,
  monthKey,
  type PullBudgetCheck,
} from "./backlinks-cost";

/**
 * DataForSEO domain_from_rank (0–1000) at or above which a lost backlink is
 * alert-worthy. Tunable; 500 ≈ the top half of their rank distribution.
 */
export const LOST_LINK_ALERT_MIN_DOMAIN_RANK = 500;
/** Rank at or above which a lost link is severity "critical" instead of "warn". */
export const LOST_LINK_CRITICAL_MIN_DOMAIN_RANK = 700;

export interface BacklinkPullPreview {
  providerName: string;
  isLive: boolean;
  target: string;
  rowsRequested: number;
  estimatedCostUsd: number;
  summaryCostUsd: number;
  spendUsedUsd: number;
  spendCapUsd: number;
  withinCap: boolean;
  blockedReason: string | null;
}

export interface BacklinkPullResult {
  pullId: string;
  status: "completed" | "blocked_cap" | "blocked_limit" | "failed";
  rowsReturned: number;
  newLinks: number;
  lostLinks: number;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  lostMarked: boolean;
  alertsEmitted: number;
  note: string | null;
}

async function effectiveSpendCapUsd(workspaceId: string): Promise<number> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { backlinksSpendCapUsd: true },
  });
  const cap = ws?.backlinksSpendCapUsd;
  return typeof cap === "number" && cap >= 0 ? cap : DEFAULT_MONTHLY_SPEND_CAP_USD;
}

/** USD spent on completed backlink pulls by this workspace this month. */
export async function monthlyBacklinkSpendUsd(workspaceId: string): Promise<number> {
  const start = new Date(`${monthKey()}-01T00:00:00.000Z`);
  const agg = await prisma.backlinkPull.aggregate({
    where: { workspaceId, status: "completed", createdAt: { gte: start } },
    _sum: { actualCostUsd: true },
  });
  return round4(agg._sum.actualCostUsd ?? 0);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

async function audit(
  workspaceId: string,
  projectId: string,
  action: "backlink_pull",
  summary: string,
): Promise<void> {
  await prisma.fileChangeLog.create({
    data: {
      workspaceId,
      projectId,
      connectionId: null,
      filePath: "",
      actor: "system",
      action,
      summary: summary.slice(0, 280),
    },
  });
}

function cleanTarget(target: string): string {
  return target.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

/**
 * Cost preview for a backlink pull. Pure read — performs no API calls and no
 * writes except the preview audit row. The UI shows this in the cost modal
 * and only calls runBacklinkPull() after explicit user confirmation.
 */
export async function previewBacklinkPull(
  workspaceId: string,
  projectId: string,
  target: string,
  requestedRows: number,
  actor = "user",
): Promise<BacklinkPullPreview> {
  const provider = getSeoProvider();
  const clean = cleanTarget(target);
  const rows = Math.max(1, Math.floor(requestedRows));

  const [spendCapUsd, spendUsedUsd] = await Promise.all([
    effectiveSpendCapUsd(workspaceId),
    monthlyBacklinkSpendUsd(workspaceId),
  ]);
  // Mock data is free: no cost estimate, no budget consumption, never blocked.
  const check: PullBudgetCheck = provider.isLive
    ? checkPullBudget(rows, spendUsedUsd, spendCapUsd)
    : { ok: true, blockedReason: null, estimatedCostUsd: 0 };
  const { estimatedCostUsd } = check;
  const summaryCostUsd = estimateSummaryPullCost();
  const blockedReason = check.blockedReason;

  await prisma.backlinkPull.create({
    data: {
      workspaceId,
      projectId,
      actor,
      target: clean,
      rowsRequested: rows,
      rowsReturned: 0,
      estimatedCostUsd,
      status: "preview",
      note: blockedReason,
    },
  });

  return {
    providerName: provider.name,
    isLive: provider.isLive,
    target: clean,
    rowsRequested: rows,
    estimatedCostUsd,
    summaryCostUsd,
    spendUsedUsd,
    spendCapUsd,
    withinCap: blockedReason === null,
    blockedReason,
  };
}

/**
 * Execute a backlink pull with full cost enforcement. Never throws for
 * cost blocks (returns status); throws only on unexpected provider failures
 * after recording a failed pull row.
 */
export async function runBacklinkPull(opts: {
  workspaceId: string;
  projectId: string;
  target: string;
  limit: number;
  actor: "user" | "cron" | "system";
  provider?: SeoDataProvider;
}): Promise<BacklinkPullResult> {
  const { workspaceId, projectId, actor } = opts;
  const provider = opts.provider ?? getSeoProvider();
  const clean = cleanTarget(opts.target);
  const rows = Math.max(1, Math.floor(opts.limit));

  const fail = async (
    status: "blocked_cap" | "blocked_limit" | "failed",
    note: string,
    estimatedCostUsd: number,
  ): Promise<BacklinkPullResult> => {
    const pull = await prisma.backlinkPull.create({
      data: {
        workspaceId, projectId, actor, target: clean,
        rowsRequested: rows, rowsReturned: 0,
        estimatedCostUsd, status, note,
      },
    });
    await audit(workspaceId, projectId, "backlink_pull", `Backlink pull ${status}: ${note}`).catch(() => {});
    return {
      pullId: pull.id, status, rowsReturned: 0, newLinks: 0, lostLinks: 0,
      estimatedCostUsd, actualCostUsd: null, lostMarked: false,
      alertsEmitted: 0, note,
    };
  };

  // 1. Hard row cap.
  if (rows > MAX_BACKLINK_ROWS_PER_PULL) {
    // Day-1: build the limit verdict directly instead of calling
    // checkPullBudget with an Infinity cap sentinel (Infinity caps are now
    // rejected by the fail-closed budget gate).
    return fail(
      "blocked_limit",
      `Requested ${rows.toLocaleString()} rows exceeds the per-pull limit of ${MAX_BACKLINK_ROWS_PER_PULL.toLocaleString()}. Lower the limit and try again.`,
      estimateListPullCost(MAX_BACKLINK_ROWS_PER_PULL) + estimateSummaryPullCost(),
    );
  }

  // 2. Spend cap (checked BEFORE any paid call).
  const budget = checkPullBudget(
    rows,
    await monthlyBacklinkSpendUsd(workspaceId),
    await effectiveSpendCapUsd(workspaceId),
  );
  if (!budget.ok) {
    return fail("blocked_cap", budget.blockedReason!, budget.estimatedCostUsd);
  }
  const estimatedCostUsd = budget.estimatedCostUsd;

  // 3. Paid calls (list + summary). The summary rides along in the same pull
  //    so the dashboard always has a fresh profile total.
  let items: BacklinkItem[];
  let rowsReturned = 0;
  let profileTotal: number | null = null;
  let mock = false;
  try {
    const [listRes, summaryRes] = await Promise.all([
      provider.backlinks({ target: clean, limit: rows }),
      provider.backlinksSummary({ target: clean }),
    ]);
    items = listRes.items;
    rowsReturned = listRes.rowsReturned;
    profileTotal = listRes.totalCount ?? summaryRes.total;
    mock = Boolean(listRes.mock || summaryRes.mock);
    void summaryRes;
  } catch (err) {
    return fail(
      "failed",
      err instanceof Error ? err.message.slice(0, 200) : "provider request failed",
      estimatedCostUsd,
    );
  }

  const now = new Date();
  const seenKeys = new Set<string>();
  let newLinks = 0;
  for (const item of items) {
    if (!item.sourceUrl || !item.targetUrl) continue;
    seenKeys.add(`${item.sourceUrl}\n${item.targetUrl}`);
    const prev = await prisma.backlink.findUnique({
      where: {
        projectId_sourceUrl_targetUrl: {
          projectId,
          sourceUrl: item.sourceUrl,
          targetUrl: item.targetUrl,
        },
      },
      select: { id: true },
    });
    const parsedFirst = item.firstSeen ? new Date(item.firstSeen) : null;
    const data = {
      sourceDomain: item.sourceDomain || hostOf(item.sourceUrl),
      sourceUrl: item.sourceUrl,
      targetUrl: item.targetUrl,
      anchorText: item.anchorText,
      dofollow: item.dofollow,
      sourceRank: item.sourceRank,
      spamScore: item.spamScore,
      lastSeen: now,
      status: "active" as const,
    };
    if (prev) {
      await prisma.backlink.update({ where: { id: prev.id }, data });
    } else {
      await prisma.backlink.create({
        data: {
          ...data,
          projectId,
          firstSeen: parsedFirst && !isNaN(parsedFirst.getTime()) ? parsedFirst : now,
        },
      });
      newLinks += 1;
    }
  }

  // 4. Lost-link detection — only on a complete pull (see module header).
  const fullCoverage = profileTotal != null && rowsReturned >= profileTotal;
  let lostLinks: { id: string; sourceDomain: string; sourceUrl: string; sourceRank: number | null }[] = [];
  if (fullCoverage && seenKeys.size > 0) {
    const candidates = await prisma.backlink.findMany({
      where: { projectId, status: "active" },
      select: { id: true, sourceDomain: true, sourceUrl: true, targetUrl: true, sourceRank: true },
    });
    const lost = candidates.filter((c) => !seenKeys.has(`${c.sourceUrl}\n${c.targetUrl}`));
    for (const l of lost) {
      await prisma.backlink.update({ where: { id: l.id }, data: { status: "lost" } });
    }
    lostLinks = lost;
  }

  // 5. Daily summary snapshot.
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const distinctDomains = new Set(items.map((i) => i.sourceDomain || hostOf(i.sourceUrl)).filter(Boolean));
  const dofollowCount = items.filter((i) => i.dofollow).length;
  await prisma.backlinkSummary.upsert({
    where: { projectId_date: { projectId, date: dayStart } },
    update: {
      total: profileTotal ?? rowsReturned,
      referringDomains: distinctDomains.size,
      dofollowRatio: items.length > 0 ? dofollowCount / items.length : null,
      snapshot: {
        active: seenKeys.size,
        lostTotal: await prisma.backlink.count({ where: { projectId, status: "lost" } }),
        newThisPull: newLinks,
        lostThisPull: lostLinks.length,
        lostMarked: fullCoverage,
        profileTotal,
        rowsReturned,
      },
      mock,
    },
    create: {
      projectId,
      date: dayStart,
      total: profileTotal ?? rowsReturned,
      referringDomains: distinctDomains.size,
      dofollowRatio: items.length > 0 ? dofollowCount / items.length : null,
      snapshot: {
        active: seenKeys.size,
        lostTotal: await prisma.backlink.count({ where: { projectId, status: "lost" } }),
        newThisPull: newLinks,
        lostThisPull: lostLinks.length,
        lostMarked: fullCoverage,
        profileTotal,
        rowsReturned,
      },
      mock,
    },
  });

  // 6. Cost record. Live pulls: estimate == actual (DataForSEO bills
  //    per request+row at pull time). Mock pulls are free: $0 actual so they
  //    never consume the monthly budget.
  const actualCostUsd = mock ? 0 : estimatedCostUsd;
  const pull = await prisma.backlinkPull.create({
    data: {
      workspaceId, projectId, actor, target: clean,
      rowsRequested: rows, rowsReturned,
      estimatedCostUsd, actualCostUsd,
      status: "completed",
      note: fullCoverage ? null : "Partial pull — lost-link marking skipped (profile larger than pull limit).",
    },
  });
  await audit(
    workspaceId,
    projectId,
    "backlink_pull",
    `Backlink pull completed: ${rowsReturned} rows, ${newLinks} new, ${lostLinks.length} lost, $${actualCostUsd.toFixed(4)} (${provider.name}${mock ? ", mock" : ""})`,
  ).catch(() => {});

  // 7. Alerts for lost high-authority links (best-effort, never breaks the pull).
  let alertsEmitted = 0;
  const dayKey = now.toISOString().slice(0, 10);
  for (const l of lostLinks) {
    const rank = l.sourceRank ?? 0;
    if (rank < LOST_LINK_ALERT_MIN_DOMAIN_RANK) continue;
    try {
      await emitAlert({
        workspaceId,
        projectId,
        trigger: "backlink_lost",
        severity: rank >= LOST_LINK_CRITICAL_MIN_DOMAIN_RANK ? "critical" : "warn",
        title: `🔗 Lost backlink from ${l.sourceDomain} (rank ${rank})`,
        body: `${l.sourceDomain} no longer links to your site. Lost links from high-authority domains can move rankings — consider outreach to restore it.`,
        link: `/dashboard/projects/${projectId}/backlinks?status=lost`,
        dedupKey: `backlink_lost:${l.sourceUrl}:${dayKey}`,
      });
      alertsEmitted += 1;
    } catch {
      // alert failures never break the pull
    }
  }

  return {
    pullId: pull.id,
    status: "completed",
    rowsReturned,
    newLinks,
    lostLinks: lostLinks.length,
    estimatedCostUsd,
    actualCostUsd,
    lostMarked: fullCoverage,
    alertsEmitted,
    note: fullCoverage ? null : "Partial pull — lost-link marking skipped.",
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
