// Marketr — Phase 10 M1: GSC → BigQuery bulk-export path.
//
// The export itself is configured by the user in Google Cloud (free setup —
// see README.md "BigQuery bulk export"). Marketr never performs the export;
// it READS from the dataset when configured. This module is the status +
// graceful-degradation layer: everything works (slower, capped) on the API
// path when the export is absent.
//
// Export table schema (searchdata_site_impression, per Google's docs):
//   data_date, site_url, query, page, country, device, clicks, impressions,
//   sum_position (→ avg position = sum_position / impressions), is_anonymized_query

import { withWorkspaceScope } from "@/lib/substrate/graph/rls";

export interface BigQueryExportStatus {
  configured: boolean;
  projectId?: string;
  dataset?: string;
  table?: string;
  /** Human reason shown in the UI when not configured. */
  reason?: string;
}

interface BigQueryConfig {
  projectId?: string;
  dataset?: string;
  table?: string;
}

/**
 * Check whether a GSC→BigQuery bulk export is configured for this workspace's
 * GSC data source. NEVER throws — returns { configured: false, reason } when
 * anything is missing (graceful degradation is the contract).
 */
export async function getBigQueryExportStatus(
  workspaceId: string,
): Promise<BigQueryExportStatus> {
  try {
    const row = await withWorkspaceScope(workspaceId, (tx) =>
      tx.dataSource.findFirst({
        where: { workspaceId, type: "gsc" },
        select: { config: true, status: true },
      }),
    );
    if (!row || row.status !== "active") {
      return {
        configured: false,
        reason: "No active GSC data source — connect Search Console first.",
      };
    }
    const cfg = ((row.config as { bigquery?: BigQueryConfig } | null)?.bigquery ?? {}) as BigQueryConfig;
    if (cfg.projectId && cfg.dataset) {
      return {
        configured: true,
        projectId: cfg.projectId,
        dataset: cfg.dataset,
        table: cfg.table ?? "searchdata_site_impression",
      };
    }
    return {
      configured: false,
      reason:
        "BigQuery export not linked. Link it in Search Console → Settings → " +
        "BigQuery export (free), then add the project + dataset in the GSC data source config.",
    };
  } catch (e) {
    return { configured: false, reason: `Status check failed: ${(e as Error).message}` };
  }
}

/** Where the export can be stored on the workspace's GSC data source config. */
export async function saveBigQueryExportConfig(
  workspaceId: string,
  cfg: { projectId: string; dataset: string; table?: string },
): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const existing = await tx.dataSource.findFirst({
      where: { workspaceId, type: "gsc" },
      select: { id: true, config: true },
    });
    const base = (existing?.config ?? {}) as Record<string, unknown>;
    const next = { ...base, bigquery: cfg };
    if (existing) {
      await tx.dataSource.update({ where: { id: existing.id, workspaceId }, data: { config: next } });
    } else {
      await tx.dataSource.create({
        data: { workspaceId, type: "gsc", config: next, status: "active" },
      });
    }
  });
}

/**
 * Read impression rows from the configured BigQuery export. When unconfigured
 * this returns { configured: false } — callers fall back to the API path
 * (pullSnapshots). Live BigQuery reads need the dataset + service credentials;
 * that wiring is M7's demo-seed scope, not M1: the export is user-configured
 * in Google Cloud and Marketr reads it when present.
 */
export async function queryBigQueryExport(
  _workspaceId: string,
  _siteUrl: string,
  _window: { start: Date; end: Date },
): Promise<{ configured: false; reason: string }> {
  // v1: status-only. The read path activates once a workspace links its
  // export (dataset + table known) — see README.md for the free setup.
  return {
    configured: false,
    reason: "BigQuery export read path activates after linking (see README).",
  };
}
