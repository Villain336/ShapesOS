// ShapesOS — Dataset Builder slice 3 follow-through (Phase 4b): staleness
// alerts that actually reach people.
//
// The health panel (health.ts) computes "Your pricing dataset is 120 days
// old" on view; this sweep turns it into an alert. For every compiled
// dataset whose newest data is older than the threshold it fires ONCE per
// compiled version:
//   - in-app notification to editors+ (lib/notifications/producers.ts),
//   - the alert hub trigger "dataset_stale" (the tenant's own rules decide
//     Slack / email / digest / quiet hours),
//   - the `dataset.stale` outbound webhook.
// The claim is a conditional UPDATE on datasets.stale_alerted_version, so two
// overlapping sweeps never double-fire; a recompile re-arms the dataset.
// Every side effect is best-effort: a failed channel never blocks the rest.

import type { PrismaClient } from "@prisma/client";
import { PrismaDatasetBuilderStore } from "./prisma-store";
import { DEFAULT_STALE_AFTER_DAYS, getDatasetHealth, HEALTH_DATASET_NAMES } from "./health";
import type { DatasetType } from "./types";
import { notifyDatasetStale } from "@/lib/notifications/producers";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import type { TriggerInput } from "@/lib/alerts/evaluate";

export interface StaleSweepOptions {
  now?: Date;
  staleAfterDays?: number;
  /** Alert hub emitter (injected so tests don't need alert rules). */
  emitAlert?: (input: TriggerInput) => Promise<unknown>;
}

export interface StaleSweepFired {
  datasetId: string;
  type: DatasetType;
  version: number;
  ageDays: number;
  message: string;
  notified: number;
}

export interface StaleSweepResult {
  workspaceId: string;
  checked: number;
  fired: StaleSweepFired[];
  skipped: number;
}

export function staleAfterDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DATASET_STALE_AFTER_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : DEFAULT_STALE_AFTER_DAYS;
}

export async function sweepDatasetStaleness(
  db: PrismaClient,
  workspaceId: string,
  opts: StaleSweepOptions = {},
): Promise<StaleSweepResult> {
  const now = opts.now ?? new Date();
  const staleAfterDays = opts.staleAfterDays ?? staleAfterDaysFromEnv();
  const store = new PrismaDatasetBuilderStore(db);
  const health = await getDatasetHealth(store, workspaceId, { now, staleAfterDays });

  const result: StaleSweepResult = { workspaceId, checked: 0, fired: [], skipped: 0 };
  for (const entry of health.datasets) {
    if (entry.latestVersion === null) continue;
    result.checked++;
    if (!entry.stale || entry.newestDataAgeDays === null) continue;
    const dataset = await store.getDatasetByType(workspaceId, entry.type);
    if (!dataset) continue;

    // Claim: only the sweep that moves stale_alerted_version to this
    // version fires (idempotent across overlapping runs and re-runs).
    const claim = await db.dataset.updateMany({
      where: {
        id: dataset.id,
        workspaceId,
        OR: [{ staleAlertedVersion: null }, { staleAlertedVersion: { not: entry.latestVersion } }],
      },
      data: { staleAlertedVersion: entry.latestVersion, staleAlertedAt: now },
    });
    if (claim.count !== 1) {
      result.skipped++;
      continue;
    }

    const name = HEALTH_DATASET_NAMES[entry.type];
    const message = `Your ${name} dataset is ${entry.newestDataAgeDays} days old`;
    const body = `The newest data in v${entry.latestVersion} is ${entry.newestDataAgeDays} days old (threshold ${staleAfterDays} days). Ingest fresh sources and recompile so answers and connectors stay current.`;

    const notified = await notifyDatasetStale(
      { workspaceId, datasetId: dataset.id, version: entry.latestVersion, title: message, body },
      db,
    );
    if (opts.emitAlert) {
      try {
        await opts.emitAlert({
          workspaceId,
          trigger: "dataset_stale",
          severity: "warn",
          title: message,
          body,
          link: "/dashboard/datasets?tab=build",
          dedupKey: `dataset_stale:${dataset.id}:v${entry.latestVersion}`,
        });
      } catch {
        // Best-effort: the alert hub records its own per-rule failures.
      }
    }
    await emitWebhookEvent({
      workspaceId,
      type: "dataset.stale",
      data: {
        datasetId: dataset.id,
        type: entry.type,
        version: entry.latestVersion,
        ageDays: entry.newestDataAgeDays,
        thresholdDays: staleAfterDays,
        message,
      },
      dedupKey: `dataset.stale:${dataset.id}:v${entry.latestVersion}`,
    });
    result.fired.push({
      datasetId: dataset.id,
      type: entry.type,
      version: entry.latestVersion,
      ageDays: entry.newestDataAgeDays,
      message,
      notified,
    });
  }
  return result;
}
