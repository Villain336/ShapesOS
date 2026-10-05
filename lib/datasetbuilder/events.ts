// ShapesOS — Dataset Builder outbound webhook events (Phase 4b).
// Best-effort, after the write commits: emitWebhookEvent never throws and
// never fails the action (no endpoint / no entitlement → nothing enqueued).

import { emitWebhookEvent, type EmitResult } from "@/lib/webhooks/emit";
import type { DatasetPublishRecord, DatasetType } from "./types";

export function emitDatasetCompiled(
  workspaceId: string,
  c: { datasetId: string; type: DatasetType; version: number; chunkCount: number; compiledAt: Date },
): Promise<EmitResult> {
  return emitWebhookEvent({
    workspaceId,
    type: "dataset.compiled",
    data: {
      datasetId: c.datasetId,
      type: c.type,
      version: c.version,
      chunkCount: c.chunkCount,
      compiledAt: c.compiledAt.toISOString(),
    },
    dedupKey: `dataset.compiled:${c.datasetId}:v${c.version}`,
  });
}

export function emitDatasetPublished(
  workspaceId: string,
  type: DatasetType,
  record: DatasetPublishRecord,
  meta: { latestVersion: number; rollback: boolean },
): Promise<EmitResult> {
  return emitWebhookEvent({
    workspaceId,
    type: "dataset.published",
    data: {
      datasetId: record.datasetId,
      type,
      target: record.target,
      version: record.version,
      latestVersion: meta.latestVersion,
      rollback: meta.rollback,
      chunkCount: record.chunkCount,
      artifactRef: record.artifactRef,
      publishedAt: record.publishedAt.toISOString(),
    },
    // One event per go-live: a later rollback to the same version is a new go-live.
    dedupKey: `dataset.published:${record.id}:${record.publishedAt.getTime()}`,
  });
}
