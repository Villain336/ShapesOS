// Marketr — local SEO service (milestone 16).
//
// The ONLY sanctioned path to spend DataForSEO local-SEO credits. Every
// geo-grid run, competitor refresh, and review ingest goes through this
// module, which enforces, in order:
//   1. Hard grid-cell cap (MAX_GRID_CELLS_PER_RUN) — over-cap grids are
//      rejected, never silently clamped.
//   2. Workspace monthly spend cap (DEFAULT or workspace-set) — an operation
//      whose estimate would exceed the remaining budget is rejected before
//      any paid API call is made.
//   3. Cost preview — preview*() returns the exact estimate the user must
//      confirm in the UI cost modal.
// Every preview and every operation (including rejections) writes a
// LocalPull row with its cost, plus a fileChangeLog audit event.
//
// Mock provider calls record $0 actual cost and never consume the budget
// (same convention as milestone 15's backlink pulls).

import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { getSeoProvider } from "@/lib/providers";
import { emitAlert } from "@/lib/alerts/evaluate";
import {
  DEFAULT_LOCAL_SPEND_CAP_USD,
  MAX_GRID_CELLS_PER_RUN,
  checkLocalBudget,
  estimateCompetitorRefreshCost,
  estimateGridRunCost,
  estimateReviewsIngestCost,
  monthKey,
} from "../seo/local-cost";
import {
  diffGridRuns,
  generateGridCells,
  matchClientPosition,
  summarizeGridRun,
  type GridCellResult,
  type GridRunSummary,
} from "./grid";
import {
  classifySentiment,
  extractThemes,
  reviewSeverity,
} from "./sentiment";

/** Rating drop (stars) that triggers a competitor alert. */
export const COMPETITOR_RATING_DROP_ALERT = 0.3;
/** New-review surge (count + %) that triggers a competitor alert. */
export const COMPETITOR_REVIEW_SURGE_MIN_NEW = 10;
export const COMPETITOR_REVIEW_SURGE_MIN_PCT = 25;
/** Geo-grid alert thresholds. */
export const GRID_COVERAGE_ALERT_PCT = 10;
export const GRID_POSITION_ALERT_SPOTS = 2;

async function effectiveSpendCapUsd(workspaceId: string): Promise<number> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { localSeoSpendCapUsd: true },
  });
  const cap = ws?.localSeoSpendCapUsd;
  return typeof cap === "number" && cap >= 0 ? cap : DEFAULT_LOCAL_SPEND_CAP_USD;
}

/** USD spent on completed local-SEO pulls by this workspace this month. */
export async function monthlyLocalSpendUsd(workspaceId: string): Promise<number> {
  const start = new Date(`${monthKey()}-01T00:00:00.000Z`);
  const agg = await prisma.localPull.aggregate({
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
  action: "local_grid_run" | "local_competitor_snapshot" | "reviews_ingested",
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

async function recordPull(args: {
  workspaceId: string;
  projectId: string;
  actor: string;
  kind: string;
  requestsMade: number;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  status: "preview" | "completed" | "blocked_cap" | "failed";
  note?: string | null;
}) {
  return prisma.localPull.create({ data: args });
}

// ---------------------------------------------------------------------------
// Geo-grid runs
// ---------------------------------------------------------------------------

export interface GridRunPreview {
  providerName: string;
  isLive: boolean;
  gridId: string;
  cells: number;
  estimatedCostUsd: number;
  spendUsedUsd: number;
  spendCapUsd: number;
  withinCap: boolean;
  blockedReason: string | null;
}

export interface GridRunResult {
  pullId: string;
  status: "completed" | "blocked_cap" | "failed";
  cells: number;
  coveragePct: number;
  avgPosition: number | null;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  alertsEmitted: number;
  note: string | null;
}

export async function previewGridRun(gridId: string): Promise<GridRunPreview | { error: string }> {
  const grid = await prisma.localGrid.findUnique({
    where: { id: gridId },
    include: { project: { select: { id: true, workspaceId: true } } },
  });
  if (!grid) return { error: "Grid not found" };
  const cells = generateGridCells(grid.centerLat, grid.centerLng, grid.radiusMiles, grid.gridSize);
  const provider = getSeoProvider();
  const estimatedCostUsd = provider.isLive ? estimateGridRunCost(cells.length) : 0;
  const spendCapUsd = await effectiveSpendCapUsd(grid.project.workspaceId);
  const spendUsedUsd = await monthlyLocalSpendUsd(grid.project.workspaceId);
  const check = checkLocalBudget(estimatedCostUsd, spendUsedUsd, spendCapUsd);
  return {
    providerName: provider.name,
    isLive: provider.isLive,
    gridId,
    cells: cells.length,
    estimatedCostUsd: check.estimatedCostUsd,
    spendUsedUsd,
    spendCapUsd,
    withinCap: check.ok,
    blockedReason: check.blockedReason,
  };
}

export async function runLocalGrid(
  gridId: string,
  actor: string,
): Promise<GridRunResult | { error: string }> {
  const grid = await prisma.localGrid.findUnique({
    where: { id: gridId },
    include: { project: { select: { id: true, workspaceId: true, domain: true } } },
  });
  if (!grid) return { error: "Grid not found" };
  const { project } = grid;

  let cells: ReturnType<typeof generateGridCells>;
  try {
    cells = generateGridCells(grid.centerLat, grid.centerLng, grid.radiusMiles, grid.gridSize);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Invalid grid geometry" };
  }

  const provider = getSeoProvider();
  const estimatedCostUsd = provider.isLive ? estimateGridRunCost(cells.length) : 0;
  const spendCapUsd = await effectiveSpendCapUsd(project.workspaceId);
  const spendUsedUsd = await monthlyLocalSpendUsd(project.workspaceId);
  const check = checkLocalBudget(estimatedCostUsd, spendUsedUsd, spendCapUsd);

  const base = {
    workspaceId: project.workspaceId,
    projectId: project.id,
    actor,
    kind: "geo_grid",
    requestsMade: 0,
    estimatedCostUsd: check.estimatedCostUsd,
    actualCostUsd: null as number | null,
    note: null as string | null,
  };

  if (!check.ok) {
    const pull = await recordPull({ ...base, status: "blocked_cap", note: check.blockedReason });
    await audit(project.workspaceId, project.id, "local_grid_run", `Geo-grid run blocked: ${check.blockedReason}`);
    return {
      pullId: pull.id,
      status: "blocked_cap",
      cells: cells.length,
      coveragePct: 0,
      avgPosition: null,
      estimatedCostUsd: check.estimatedCostUsd,
      actualCostUsd: null,
      alertsEmitted: 0,
      note: check.blockedReason,
    };
  }

  // Previous run for delta alerts (fetched before we insert the new one).
  const previous = await prisma.localGridResult.findFirst({
    where: { localGridId: grid.id },
    orderBy: { runAt: "desc" },
    select: { coveragePct: true, avgPosition: true },
  });

  const cellResults: GridCellResult[] = [];
  let failed = 0;
  for (const cell of cells) {
    try {
      const res = await provider.mapsSerp({
        keyword: grid.keyword,
        lat: cell.lat,
        lng: cell.lng,
      });
      const position = matchClientPosition(res.items, grid.businessName);
      cellResults.push({
        ...cell,
        position,
        topBusiness: res.items[0]?.businessName ?? null,
      });
    } catch {
      failed += 1;
      cellResults.push({ ...cell, position: null, topBusiness: null });
    }
  }

  const summary: GridRunSummary = summarizeGridRun(cellResults);
  const actualCostUsd = provider.isLive ? check.estimatedCostUsd : 0;
  const note = failed > 0 ? `${failed} of ${cells.length} cells failed (kept as absent)` : null;

  const [pull] = await prisma.$transaction([
    prisma.localPull.create({
      data: {
        ...base,
        requestsMade: cells.length - failed,
        actualCostUsd,
        status: "completed",
        note,
      },
    }),
    prisma.localGridResult.create({
      data: {
        localGridId: grid.id,
        cells: cellResults as unknown as object,
        coveragePct: summary.coveragePct,
        avgPosition: summary.avgPosition,
        costUsd: actualCostUsd,
        mock: !provider.isLive,
      },
    }),
    prisma.localGrid.update({
      where: { id: grid.id },
      data: { lastRunAt: new Date() },
    }),
  ]);

  await audit(
    project.workspaceId,
    project.id,
    "local_grid_run",
    `Geo-grid "${grid.name}" ran: ${summary.cells} cells, ${summary.coveragePct}% coverage, avg position ${summary.avgPosition ?? "—"} ($${actualCostUsd.toFixed(4)}).`,
  );

  // Delta alerts vs the previous run.
  let alertsEmitted = 0;
  if (previous) {
    const delta = diffGridRuns(
      { cells: 0, coveragePct: previous.coveragePct, avgPosition: previous.avgPosition },
      summary,
    );
    const dayKey = new Date().toISOString().slice(0, 10);
    const coverageMoved = Math.abs(delta.coverageDeltaPct) >= GRID_COVERAGE_ALERT_PCT;
    const positionMoved =
      delta.avgPositionDelta != null && Math.abs(delta.avgPositionDelta) >= GRID_POSITION_ALERT_SPOTS;
    if (coverageMoved || positionMoved) {
      const worsened = delta.coverageDeltaPct < 0 || (delta.avgPositionDelta ?? 0) < 0;
      try {
        await emitAlert({
          workspaceId: project.workspaceId,
          projectId: project.id,
          trigger: "geo_grid_change",
          severity: Math.abs(delta.coverageDeltaPct) >= 25 ? "critical" : worsened ? "warn" : "info",
          title: `📍 Geo-grid shift: "${grid.keyword}" (${grid.name})`,
          body:
            `Coverage ${summary.coveragePct}% (${delta.coverageDeltaPct >= 0 ? "+" : ""}${delta.coverageDeltaPct} pts), ` +
            `avg position ${summary.avgPosition ?? "—"}` +
            (delta.avgPositionDelta != null
              ? ` (${delta.avgPositionDelta >= 0 ? "improved" : "dropped"} ${Math.abs(delta.avgPositionDelta)} spots)`
              : "") +
            ` across ${summary.cells} cells.`,
          link: `/dashboard/projects/${project.id}/local`,
          dedupKey: `geo_grid_change:${grid.id}:${dayKey}`,
          delta: delta.coverageDeltaPct,
        });
        alertsEmitted += 1;
      } catch {
        // alert failures never break the run
      }
    }
  }

  return {
    pullId: pull.id,
    status: "completed",
    cells: summary.cells,
    coveragePct: summary.coveragePct,
    avgPosition: summary.avgPosition,
    estimatedCostUsd: check.estimatedCostUsd,
    actualCostUsd,
    alertsEmitted,
    note,
  };
}

// ---------------------------------------------------------------------------
// Competitor refresh
// ---------------------------------------------------------------------------

export interface CompetitorRefreshResult {
  status: "completed" | "blocked_cap" | "failed";
  refreshed: number;
  skipped: number;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  alertsEmitted: number;
  note: string | null;
}

export async function refreshLocalCompetitors(
  projectId: string,
  actor: string,
): Promise<CompetitorRefreshResult | { error: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true },
  });
  if (!project) return { error: "Project not found" };

  const competitors = await prisma.localCompetitor.findMany({
    where: { projectId, enabled: true },
    include: { snapshots: { orderBy: { date: "desc" }, take: 1 } },
  });

  const provider = getSeoProvider();
  const estimatedCostUsd = provider.isLive ? estimateCompetitorRefreshCost(competitors.length) : 0;
  const spendCapUsd = await effectiveSpendCapUsd(project.workspaceId);
  const spendUsedUsd = await monthlyLocalSpendUsd(project.workspaceId);
  const check = checkLocalBudget(estimatedCostUsd, spendUsedUsd, spendCapUsd);

  const base = {
    workspaceId: project.workspaceId,
    projectId,
    actor,
    kind: "competitor_refresh",
    requestsMade: 0,
    estimatedCostUsd: check.estimatedCostUsd,
    actualCostUsd: null as number | null,
    note: null as string | null,
  };

  if (!check.ok) {
    await recordPull({ ...base, status: "blocked_cap", note: check.blockedReason });
    await audit(project.workspaceId, projectId, "local_competitor_snapshot", `Competitor refresh blocked: ${check.blockedReason}`);
    return {
      status: "blocked_cap",
      refreshed: 0,
      skipped: competitors.length,
      estimatedCostUsd: check.estimatedCostUsd,
      actualCostUsd: null,
      alertsEmitted: 0,
      note: check.blockedReason,
    };
  }

  let refreshed = 0;
  let skipped = 0;
  let alertsEmitted = 0;
  const dayKey = new Date().toISOString().slice(0, 10);

  for (const c of competitors) {
    if (c.lat == null || c.lng == null) {
      skipped += 1;
      continue;
    }
    try {
      const listings = await provider.businessListings({
        keyword: c.businessName,
        lat: c.lat,
        lng: c.lng,
        limit: 5,
      });
      // Best match: same place id, else best name match.
      const listing =
        listings.find((l) => c.placeId && l.placeId === c.placeId) ??
        listings.find((l) => l.businessName.toLowerCase().includes(c.businessName.toLowerCase().slice(0, 12))) ??
        listings[0];
      if (!listing) {
        skipped += 1;
        continue;
      }
      await prisma.localCompetitorSnapshot.create({
        data: {
          localCompetitorId: c.id,
          rating: listing.rating,
          reviewCount: listing.reviewCount,
          categories: listing.categories,
          address: listing.address,
          mock: !provider.isLive,
        },
      });
      await prisma.localCompetitor.update({
        where: { id: c.id },
        data: {
          lastSnapshotAt: new Date(),
          placeId: c.placeId ?? listing.placeId,
          domain: c.domain ?? listing.domain,
        },
      });
      refreshed += 1;

      // Diff vs previous snapshot → alerts.
      const prev = c.snapshots[0];
      if (prev) {
        const events: string[] = [];
        let severity: "info" | "warn" | "critical" = "info";
        if (prev.rating != null && listing.rating != null) {
          const drop = prev.rating - listing.rating;
          if (drop >= COMPETITOR_RATING_DROP_ALERT) {
            events.push(`rating fell ${prev.rating.toFixed(1)} → ${listing.rating.toFixed(1)}★`);
            severity = drop >= 0.5 ? "critical" : "warn";
          }
        }
        if (prev.reviewCount != null && listing.reviewCount != null) {
          const gained = listing.reviewCount - prev.reviewCount;
          const pct = prev.reviewCount > 0 ? (gained / prev.reviewCount) * 100 : 0;
          if (gained >= COMPETITOR_REVIEW_SURGE_MIN_NEW && pct >= COMPETITOR_REVIEW_SURGE_MIN_PCT) {
            events.push(`review surge: +${gained} reviews (+${Math.round(pct)}%)`);
            if (severity === "info") severity = "warn";
          }
        }
        if (events.length > 0) {
          try {
            await emitAlert({
              workspaceId: project.workspaceId,
              projectId,
              trigger: "local_competitor_moved",
              severity,
              title: `🏪 Competitor moved: ${c.businessName}`,
              body: events.join("; ") + ".",
              link: `/dashboard/projects/${projectId}/local`,
              dedupKey: `local_competitor_moved:${c.id}:${dayKey}`,
            });
            alertsEmitted += 1;
          } catch {
            // alert failures never break the refresh
          }
        }
      }
    } catch {
      skipped += 1;
    }
  }

  const actualCostUsd = provider.isLive ? check.estimatedCostUsd : 0;
  await recordPull({
    ...base,
    requestsMade: refreshed,
    actualCostUsd,
    status: "completed",
    note: skipped > 0 ? `${skipped} competitor(s) skipped (no location or no listing found)` : null,
  });
  await audit(
    project.workspaceId,
    projectId,
    "local_competitor_snapshot",
    `Competitor refresh: ${refreshed} refreshed, ${skipped} skipped ($${actualCostUsd.toFixed(4)}).`,
  );

  return {
    status: "completed",
    refreshed,
    skipped,
    estimatedCostUsd: check.estimatedCostUsd,
    actualCostUsd,
    alertsEmitted,
    note: skipped > 0 ? `${skipped} competitor(s) skipped (no location or no listing found)` : null,
  };
}

// ---------------------------------------------------------------------------
// Review ingest
// ---------------------------------------------------------------------------

export interface ReviewsIngestResult {
  status: "completed" | "blocked_cap" | "skipped" | "failed";
  fetched: number;
  newReviews: number;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  alertsEmitted: number;
  note: string | null;
}

/**
 * Resolve the review target for a project: the first enabled geo-grid's
 * business name + center. Reviews are ingested per business, and the grid
 * already captures "which business in which market".
 */
async function resolveReviewTarget(projectId: string) {
  const grid = await prisma.localGrid.findFirst({
    where: { projectId, enabled: true },
    orderBy: { createdAt: "asc" },
    select: { businessName: true, centerLat: true, centerLng: true },
  });
  return grid;
}

function syntheticReviewId(author: string | null, text: string | null, publishedAt: string | null): string {
  return (
    "syn-" +
    createHash("sha1")
      .update(`${author ?? ""}|${(text ?? "").slice(0, 500)}|${publishedAt ?? ""}`)
      .digest("hex")
      .slice(0, 24)
  );
}

export async function ingestReviews(
  projectId: string,
  actor: string,
): Promise<ReviewsIngestResult | { error: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true },
  });
  if (!project) return { error: "Project not found" };

  const target = await resolveReviewTarget(projectId);
  if (!target) {
    return {
      status: "skipped",
      fetched: 0,
      newReviews: 0,
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      alertsEmitted: 0,
      note: "No enabled geo-grid on this project — create one to set the business + market for review monitoring.",
    };
  }

  const provider = getSeoProvider();
  const estimatedCostUsd = provider.isLive ? estimateReviewsIngestCost() : 0;
  const spendCapUsd = await effectiveSpendCapUsd(project.workspaceId);
  const spendUsedUsd = await monthlyLocalSpendUsd(project.workspaceId);
  const check = checkLocalBudget(estimatedCostUsd, spendUsedUsd, spendCapUsd);

  const base = {
    workspaceId: project.workspaceId,
    projectId,
    actor,
    kind: "reviews_ingest",
    requestsMade: 0,
    estimatedCostUsd: check.estimatedCostUsd,
    actualCostUsd: null as number | null,
    note: null as string | null,
  };

  if (!check.ok) {
    await recordPull({ ...base, status: "blocked_cap", note: check.blockedReason });
    await audit(project.workspaceId, projectId, "reviews_ingested", `Review ingest blocked: ${check.blockedReason}`);
    return {
      status: "blocked_cap",
      fetched: 0,
      newReviews: 0,
      estimatedCostUsd: check.estimatedCostUsd,
      actualCostUsd: null,
      alertsEmitted: 0,
      note: check.blockedReason,
    };
  }

  let items: Awaited<ReturnType<typeof provider.businessReviews>>["items"];
  try {
    const res = await provider.businessReviews({
      keyword: target.businessName,
      lat: target.centerLat,
      lng: target.centerLng,
      depth: 20,
    });
    items = res.items;
  } catch (err) {
    await recordPull({
      ...base,
      status: "failed",
      note: err instanceof Error ? err.message.slice(0, 200) : "provider error",
    });
    return {
      status: "failed",
      fetched: 0,
      newReviews: 0,
      estimatedCostUsd: check.estimatedCostUsd,
      actualCostUsd: null,
      alertsEmitted: 0,
      note: err instanceof Error ? err.message.slice(0, 200) : "provider error",
    };
  }

  let newReviews = 0;
  let alertsEmitted = 0;
  for (const item of items) {
    const externalId = item.externalId ?? syntheticReviewId(item.author, item.text, item.publishedAt);
    const existing = await prisma.review.findUnique({
      where: { projectId_externalId: { projectId, externalId } },
      select: { id: true },
    });
    if (existing) continue;

    const { sentiment, via } = await classifySentiment(item.text, item.rating, project.workspaceId);
    const created = await prisma.review.create({
      data: {
        projectId,
        externalId,
        businessName: target.businessName,
        author: item.author,
        rating: item.rating,
        text: item.text,
        publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
        sentiment,
        sentimentVia: via,
        mock: !provider.isLive,
      },
    });
    newReviews += 1;

    // 1–2★ reviews alert immediately.
    if (item.rating != null && item.rating <= 2) {
      try {
        await emitAlert({
          workspaceId: project.workspaceId,
          projectId,
          trigger: "negative_review",
          severity: reviewSeverity(item.rating),
          title: `⭐ ${item.rating}-star review for ${target.businessName}`,
          body: `${item.author ?? "A reviewer"} wrote: “${(item.text ?? "").slice(0, 220)}”`,
          link: `/dashboard/projects/${projectId}/local`,
          dedupKey: `negative_review:${created.id}`,
        });
        alertsEmitted += 1;
      } catch {
        // alert failures never break the ingest
      }
    }
  }

  // Weekly summary over the trailing 7 days (upsert by day).
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const recent = await prisma.review.findMany({
    where: { projectId, createdAt: { gte: weekAgo } },
    select: { rating: true, sentiment: true, text: true },
  });
  const ratings = recent.map((r) => r.rating).filter((r): r is number => r != null);
  const periodStart = new Date();
  periodStart.setUTCHours(0, 0, 0, 0);
  if (recent.length > 0) {
    await prisma.reviewSummary.upsert({
      where: { projectId_period_periodStart: { projectId, period: "weekly", periodStart } },
      update: {
        avgRating: ratings.length ? round4(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null,
        count: recent.length,
        posCount: recent.filter((r) => r.sentiment === "pos").length,
        neuCount: recent.filter((r) => r.sentiment === "neu").length,
        negCount: recent.filter((r) => r.sentiment === "neg").length,
        topThemes: extractThemes(recent.map((r) => r.text)) as unknown as object,
      },
      create: {
        projectId,
        period: "weekly",
        periodStart,
        avgRating: ratings.length ? round4(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null,
        count: recent.length,
        posCount: recent.filter((r) => r.sentiment === "pos").length,
        neuCount: recent.filter((r) => r.sentiment === "neu").length,
        negCount: recent.filter((r) => r.sentiment === "neg").length,
        topThemes: extractThemes(recent.map((r) => r.text)) as unknown as object,
      },
    });
  }

  const actualCostUsd = provider.isLive ? check.estimatedCostUsd : 0;
  await recordPull({ ...base, requestsMade: 1, actualCostUsd, status: "completed" });
  await audit(
    project.workspaceId,
    projectId,
    "reviews_ingested",
    `Review ingest for ${target.businessName}: ${items.length} fetched, ${newReviews} new ($${actualCostUsd.toFixed(4)}).`,
  );

  return {
    status: "completed",
    fetched: items.length,
    newReviews,
    estimatedCostUsd: check.estimatedCostUsd,
    actualCostUsd,
    alertsEmitted,
    note: null,
  };
}
