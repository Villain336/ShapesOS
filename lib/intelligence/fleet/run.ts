// Marketr — Phase 10 M4: weekly fleet run orchestrator.
//
// One weekly pass per workspace:
//   1. Discovery — sitemap diff per CompetitorWatch (polite, robots-safe).
//   2. Change detection — tracked URLs re-fetched + hashed + diffed.
//   3. AI summaries — semantic_summary / why_it_matters /
//      recommended_response per new change (PROPOSE-only; nothing auto-acts).
//   4. Digest — weekly aggregation object (returned + surfaced via the
//      competitor_radar alert by the cron route).
//
// All DB access via withWorkspaceScope. Every step is failure-isolated: one
// watch failing never fails the workspace run.

import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { PoliteFetcher } from "./polite-fetch";
import { createRobotsCache } from "./robots";
import { runDiscoveryForWatch, type WatchRow } from "./discovery";
import { runChangeDetection } from "./detect";
import { summarizeChange } from "./summarize";

export interface FleetRunResult {
  workspaceId: string;
  watches: number;
  discovery: Array<{ watchId: string; domain: string; rowsCreated: number; error?: string }>;
  detection: Array<{ watchId: string; checked: number; changed: number; skippedRobots: number }>;
  summarized: number;
  errors: string[];
}

/** Summarize unsummarized changes for a watch (bounded per run). */
async function summarizeNewChanges(
  workspaceId: string,
  watch: WatchRow,
  limit: number,
): Promise<number> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const pending = await tx.competitorChange.findMany({
      where: { watchId: watch.id, semanticSummary: null, status: "new" },
      select: { id: true, url: true, changeType: true },
      orderBy: { detectedAt: "desc" },
      take: limit,
    });
    let done = 0;
    for (const c of pending) {
      try {
        await summarizeChange({
          tx,
          changeId: c.id,
          workspaceId,
          projectId: watch.projectId,
          competitorDomain: watch.competitorDomain,
          url: c.url,
          changeType: c.changeType,
        });
        done++;
      } catch {
        // one summary failing never fails the run
      }
    }
    return done;
  });
}

export async function runFleetForWorkspace(workspaceId: string): Promise<FleetRunResult> {
  const fetcher = new PoliteFetcher();
  const robotsCache = createRobotsCache();
  const result: FleetRunResult = {
    workspaceId,
    watches: 0,
    discovery: [],
    detection: [],
    summarized: 0,
    errors: [],
  };

  const watches: WatchRow[] = await withWorkspaceScope(workspaceId, (tx) =>
    tx.competitorWatch.findMany({
      where: { workspaceId },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        competitorDomain: true,
        sitemapUrl: true,
        lastDiffAt: true,
        newUrls: true,
      },
    }),
  );
  result.watches = watches.length;

  for (const watch of watches) {
    // 1. Discovery
    try {
      const d = await withWorkspaceScope(workspaceId, (tx) =>
        runDiscoveryForWatch({ tx, watch, fetcher }),
      );
      result.discovery.push({
        watchId: watch.id,
        domain: watch.competitorDomain,
        rowsCreated: d.rowsCreated,
        error: d.error,
      });
    } catch (err) {
      result.errors.push(
        `discovery ${watch.competitorDomain}: ${err instanceof Error ? err.message : "failed"}`,
      );
    }

    // 2. Change detection over tracked URLs (the watch's discovered URL set).
    try {
      const tracked = await withWorkspaceScope(workspaceId, (tx) =>
        tx.competitorWatch.findUnique({
          where: { id: watch.id },
          select: { newUrls: true },
        }),
      );
      const det = await withWorkspaceScope(workspaceId, (tx) =>
        runChangeDetection({
          tx,
          workspaceId,
          watch,
          trackedUrls: tracked?.newUrls ?? [],
          fetcher,
          robotsCache,
        }),
      );
      result.detection.push({
        watchId: watch.id,
        checked: det.checked,
        changed: det.changed,
        skippedRobots: det.skippedRobots.length,
      });
    } catch (err) {
      result.errors.push(
        `detection ${watch.competitorDomain}: ${err instanceof Error ? err.message : "failed"}`,
      );
    }

    // 3. AI summaries for the new rows (bounded: 10 per watch per week).
    try {
      result.summarized += await summarizeNewChanges(workspaceId, watch, 10);
    } catch (err) {
      result.errors.push(
        `summarize ${watch.competitorDomain}: ${err instanceof Error ? err.message : "failed"}`,
      );
    }
  }

  return result;
}
