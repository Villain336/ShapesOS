// ShapesOS — Dataset Builder slices 3–4 follow-through (Phase 4b), no DB:
// rollback / roll-forward semantics in the in-memory store (mirrors
// Postgres), the BriefNow MCP pull reference, cross-dataset grounding, and
// the new webhook payloads validating against the event catalog.
// Run: npx tsx --test lib/datasetbuilder/__tests__/activate-rollback.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryDatasetBuilderStore } from "../store";
import { ingestPaste } from "../ingest";
import { compileDataset } from "../build";
import {
  askPublishedDatasets,
  briefNowAdaptersRoot,
  briefNowPullRef,
  getLiveBriefNowPackage,
  publishDataset,
} from "../activate";
import { staleAfterDaysFromEnv } from "../stale-sweep";
import type { DatasetType } from "../types";
import { WEBHOOK_EVENT_SCHEMAS } from "../../webhooks/events";
import { cadErrorStatus } from "../../cad/route-errors";

const WS = "ws-rollback";

async function seed(store: InMemoryDatasetBuilderStore, text: string, type: DatasetType, label: string) {
  const r = await ingestPaste(store, { workspaceId: WS, label, text });
  const chunks = await store.listChunksByDocument(r.document.id);
  await store.upsertClassification({
    workspaceId: WS,
    chunkId: chunks[0]!.id,
    datasetType: type,
    confidence: 0.9,
    engine: "rules",
    engineVersion: "rules-v1",
    status: "applied",
  });
}

describe("rollback / roll-forward (in-memory store mirrors Postgres)", () => {
  it("the live record is the most recently published, not the highest version", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seed(store, "Starter costs $29 per month.", "pricing", "a");
    const { dataset } = await compileDataset(store, WS, "pricing");
    await seed(store, "Growth costs $99 per month.", "pricing", "b");
    await compileDataset(store, WS, "pricing");

    const v2 = await publishDataset(store, { workspaceId: WS, datasetId: dataset.id, target: "rag" });
    assert.equal(v2.record.version, 2);
    const v1 = await publishDataset(store, { workspaceId: WS, datasetId: dataset.id, target: "rag", version: 1 });
    assert.equal(v1.rollback, true);
    assert.equal((await store.getLatestPublishRecord(dataset.id, "rag"))!.version, 1);
    const noop = await publishDataset(store, { workspaceId: WS, datasetId: dataset.id, target: "rag", version: 1 });
    assert.equal(noop.alreadyLive, true);
    const fwd = await publishDataset(store, { workspaceId: WS, datasetId: dataset.id, target: "rag", version: 2 });
    assert.equal(fwd.record.id, v2.record.id);
    assert.equal((await store.getLatestPublishRecord(dataset.id, "rag"))!.version, 2);

    // Grounding follows the live version: after the roll-forward, $99 is findable.
    const ans = await askPublishedDatasets(store, WS, "How much does Growth cost?");
    assert.equal(ans.grounded, true);
    assert.ok(ans.citations.some((c) => /\$99/.test(c.excerpt)));
  });

  it("BriefNow without a file-drop root publishes an MCP pull reference", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seed(store, "We ship within 2 business days.", "policy", "p");
    const { dataset } = await compileDataset(store, WS, "policy");
    const res = await publishDataset(store, { workspaceId: WS, datasetId: dataset.id, target: "briefnow", adapterWriter: null });
    assert.equal(res.record.artifactRef, briefNowPullRef("policy", 1));
    assert.equal(res.adapterPackage?.contract, "briefnow-dataset-adapter/v1");
    const live = await getLiveBriefNowPackage(store, WS, "policy", { offset: 5, limit: 999 });
    assert.equal(live!.page.limit, 200);
    assert.equal(live!.package.entries.length, 0);
    assert.equal(live!.page.nextOffset, null);
    assert.equal(await getLiveBriefNowPackage(store, "someone-else", "policy"), null);
  });

  it("env parsing: adapters root and staleness threshold", () => {
    const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
    assert.equal(briefNowAdaptersRoot(env({})), null);
    assert.equal(briefNowAdaptersRoot(env({ BRIEFNOW_ADAPTERS_ROOT: "  " })), null);
    assert.ok(briefNowAdaptersRoot(env({ BRIEFNOW_ADAPTERS_ROOT: "/srv/briefnow" }))!.endsWith("briefnow"));
    // Deploy PR: the local file drop is self-host only; hosted pulls over MCP.
    assert.equal(briefNowAdaptersRoot(env({ BRIEFNOW_ADAPTERS_ROOT: "/srv/briefnow", DEPLOYMENT_MODE: "hosted" })), null);
    assert.equal(staleAfterDaysFromEnv(env({})), 90);
    assert.equal(staleAfterDaysFromEnv(env({ DATASET_STALE_AFTER_DAYS: "30" })), 30);
    assert.equal(staleAfterDaysFromEnv(env({ DATASET_STALE_AFTER_DAYS: "-1" })), 90);
    assert.equal(staleAfterDaysFromEnv(env({ DATASET_STALE_AFTER_DAYS: "abc" })), 90);
  });
});

describe("Phase 4b webhook payloads + CAD route errors", () => {
  it("producer payload shapes validate against the event catalog", () => {
    const now = new Date().toISOString();
    assert.ok(WEBHOOK_EVENT_SCHEMAS["dataset.compiled"].safeParse({ datasetId: "d", type: "faq", version: 1, chunkCount: 3, compiledAt: now }).success);
    assert.ok(
      WEBHOOK_EVENT_SCHEMAS["dataset.published"].safeParse({
        datasetId: "d", type: "faq", target: "rag", version: 1, latestVersion: 2, rollback: true, chunkCount: 3, artifactRef: "rag://w/faq/v1", publishedAt: now,
      }).success,
    );
    assert.ok(
      WEBHOOK_EVENT_SCHEMAS["dataset.stale"].safeParse({ datasetId: "d", type: "pricing", version: 2, ageDays: 120, thresholdDays: 90, message: "Your pricing dataset is 120 days old" }).success,
    );
    assert.ok(
      WEBHOOK_EVENT_SCHEMAS["cad.bom_derived"].safeParse({
        bomId: "b", bomNumber: 1, modelId: "m", modelVersionId: "v", versionNumber: 1, lineCount: 2, bodyCount: 3, material: null, totalMassG: null, totalUsd: 0, linesMissingCost: 2,
      }).success,
    );
    assert.equal(WEBHOOK_EVENT_SCHEMAS["cad.bom_derived"].safeParse({ bomId: "b" }).success, false);
  });

  it("CAD domain errors map to 404 / 422 / 409 / 400", () => {
    assert.equal(cadErrorStatus("BOM_NOT_FOUND"), 404);
    assert.equal(cadErrorStatus("MODEL_NOT_FOUND"), 404);
    assert.equal(cadErrorStatus("DERIVE_UNAVAILABLE"), 422);
    assert.equal(cadErrorStatus("FILE_INTEGRITY"), 409);
    assert.equal(cadErrorStatus("DERIVED_QTY_IMMUTABLE"), 400);
  });
});
