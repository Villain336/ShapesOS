// Marketr — Dataset Builder slice 3: dataset health.
// Coverage (what % of chunks are classified into datasets), freshness
// (age of the newest data per dataset), and staleness alerts
// ("your pricing dataset is 90 days old"). Deterministic: pass `now`
// explicitly in tests; production passes the real clock.

import {
  DATASET_TYPES,
  DATASET_TYPE_LABELS,
  type DatasetType,
} from "./classify";
import type {
  DatasetBuilderStore,
  DatasetChunkRecord,
} from "./types";

export const DEFAULT_STALE_AFTER_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/** Sentence-case dataset names for alert copy. */
export const HEALTH_DATASET_NAMES: Record<DatasetType, string> = {
  faq: "FAQ",
  product_catalog: "product catalog",
  policy: "policy",
  process_sop: "process/SOP",
  company_fact: "company fact",
  pricing: "pricing",
};

export type DatasetHealthAlertSeverity = "stale" | "drift" | "uncompiled";

export interface DatasetHealthAlert {
  datasetType: DatasetType | null;
  label: string;
  severity: DatasetHealthAlertSeverity;
  /** Sentence case, ready to render. */
  message: string;
}

export interface DatasetHealthEntry {
  type: DatasetType;
  label: string;
  /** Chunks with an applied classification of this type. */
  appliedChunks: number;
  /** appliedChunks / workspace total chunks, 0–100. */
  coveragePct: number;
  latestVersion: number | null;
  latestCompiledAt: Date | null;
  /** Newest chunk createdAt among this type's applied chunks. */
  newestDataAt: Date | null;
  newestDataAgeDays: number | null;
  stale: boolean;
  /** Applied chunks that arrived after the latest compile. */
  chunksSinceCompile: number;
}

export interface DatasetHealth {
  workspaceId: string;
  generatedAt: Date;
  totalChunks: number;
  /** Distinct chunks with an applied classification of any type. */
  classifiedChunks: number;
  coveragePct: number;
  datasets: DatasetHealthEntry[];
  alerts: DatasetHealthAlert[];
}

export interface HealthOptions {
  now?: Date;
  staleAfterDays?: number;
}

export async function getDatasetHealth(
  store: DatasetBuilderStore,
  workspaceId: string,
  opts: HealthOptions = {},
): Promise<DatasetHealth> {
  const now = opts.now ?? new Date();
  const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;

  const chunks = await store.listAllChunks(workspaceId);
  const chunksById = new Map<string, DatasetChunkRecord>(
    chunks.map((c) => [c.id, c]),
  );
  const totalChunks = chunks.length;

  const classifiedChunkIds = new Set<string>();
  const entries: DatasetHealthEntry[] = [];

  for (const type of DATASET_TYPES) {
    const applied = (await store.listClassificationsByType(workspaceId, type))
      .filter((c) => c.status === "applied");
    const distinctChunkIds = new Set(applied.map((c) => c.chunkId));
    for (const id of distinctChunkIds) classifiedChunkIds.add(id);

    const dataset = await store.getDatasetByType(workspaceId, type);
    const latest = dataset
      ? await store.getLatestDatasetVersion(dataset.id)
      : null;

    let newestDataAt: Date | null = null;
    for (const id of distinctChunkIds) {
      const chunk = chunksById.get(id);
      if (chunk && (!newestDataAt || chunk.createdAt > newestDataAt)) {
        newestDataAt = chunk.createdAt;
      }
    }
    const newestDataAgeDays =
      newestDataAt === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - newestDataAt.getTime()) / MS_PER_DAY));
    const stale =
      newestDataAgeDays !== null && newestDataAgeDays > staleAfterDays;

    let chunksSinceCompile = 0;
    if (latest) {
      for (const id of distinctChunkIds) {
        const chunk = chunksById.get(id);
        if (chunk && chunk.createdAt > latest.compiledAt) {
          chunksSinceCompile += 1;
        }
      }
    }

    entries.push({
      type,
      label: DATASET_TYPE_LABELS[type],
      appliedChunks: distinctChunkIds.size,
      coveragePct: pct(distinctChunkIds.size, totalChunks),
      latestVersion: latest?.version ?? null,
      latestCompiledAt: latest?.compiledAt ?? null,
      newestDataAt,
      newestDataAgeDays,
      stale,
      chunksSinceCompile,
    });
  }

  const classifiedChunks = classifiedChunkIds.size;
  const alerts: DatasetHealthAlert[] = [];
  for (const entry of entries) {
    const name = HEALTH_DATASET_NAMES[entry.type];
    if (entry.stale && entry.newestDataAgeDays !== null) {
      alerts.push({
        datasetType: entry.type,
        label: entry.label,
        severity: "stale",
        message: `Your ${name} dataset is ${entry.newestDataAgeDays} days old`,
      });
    }
    if (entry.chunksSinceCompile > 0 && entry.latestVersion !== null) {
      const n = entry.chunksSinceCompile;
      alerts.push({
        datasetType: entry.type,
        label: entry.label,
        severity: "drift",
        message:
          `${n} new ${name} ${n === 1 ? "chunk" : "chunks"} since v${entry.latestVersion} — ` +
          "recompile to refresh",
      });
    }
    if (entry.appliedChunks > 0 && entry.latestVersion === null) {
      alerts.push({
        datasetType: entry.type,
        label: entry.label,
        severity: "uncompiled",
        message: `Compile your first ${name} dataset from ${entry.appliedChunks} classified ${entry.appliedChunks === 1 ? "chunk" : "chunks"}`,
      });
    }
  }

  return {
    workspaceId,
    generatedAt: now,
    totalChunks,
    classifiedChunks,
    coveragePct: pct(classifiedChunks, totalChunks),
    datasets: entries,
    alerts,
  };
}

function pct(n: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((n / total) * 1000) / 10;
}
