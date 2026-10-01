// Marketr — Dataset Builder slice 3 tests: dataset health.
// Run: npx tsx --test lib/datasetbuilder/__tests__/health.test.ts
//
// Under test: coverage math (classified / total), freshness (age of
// newest data per dataset), and staleness/drift/uncompiled alerts.
// Deterministic: every test injects `now` relative to real createdAt
// timestamps — no sleeps, no wall-clock dependence.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryDatasetBuilderStore } from "../store";
import type { DatasetType } from "../classify";
import { ingestPaste } from "../ingest";
import { compileDataset } from "../build";
import { getDatasetHealth } from "../health";

const WS = "ws-test";
const DAY = 86_400_000;

async function seedClassified(
  store: InMemoryDatasetBuilderStore,
  entries: { text: string; type: DatasetType }[],
): Promise<void> {
  for (const [i, entry] of entries.entries()) {
    const result = await ingestPaste(store, {
      workspaceId: WS,
      label: `seed-${i}`,
      text: entry.text,
    });
    const docChunks = await store.listChunksByDocument(result.document.id);
    for (const chunk of docChunks) {
      await store.upsertClassification({
        workspaceId: WS,
        chunkId: chunk.id,
        datasetType: entry.type,
        confidence: 0.9,
        engine: "rules",
        engineVersion: "rules-v1",
        status: "applied",
      });
    }
  }
}

describe("getDatasetHealth", () => {
  it("computes coverage as classified chunks over total chunks", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Our pricing starts at $10 per month for the starter plan.", type: "pricing" },
      { text: "What is your refund policy? We offer 30-day refunds.", type: "faq" },
    ]);
    await ingestPaste(store, {
      workspaceId: WS,
      label: "unclassified",
      text: "Nobody classified this paragraph yet.",
    });

    const health = await getDatasetHealth(store, WS);
    assert.equal(health.totalChunks, 3);
    assert.equal(health.classifiedChunks, 2);
    assert.equal(health.coveragePct, 66.7);

    const pricing = health.datasets.find((d) => d.type === "pricing");
    assert.ok(pricing);
    assert.equal(pricing.appliedChunks, 1);
    assert.equal(pricing.coveragePct, 33.3);
    assert.equal(pricing.latestVersion, null);
  });

  it("is empty-safe with no chunks at all", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const health = await getDatasetHealth(store, WS);
    assert.equal(health.totalChunks, 0);
    assert.equal(health.coveragePct, 0);
    assert.deepEqual(health.alerts, []);
    for (const d of health.datasets) {
      assert.equal(d.newestDataAgeDays, null);
      assert.equal(d.stale, false);
    }
  });

  it("flags a stale dataset with the days-old message", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Our pricing starts at $10 per month for the starter plan.", type: "pricing" },
    ]);
    await compileDataset(store, WS, "pricing");

    const chunks = await store.listAllChunks(WS);
    const oldest = new Date(chunks[0].createdAt.getTime() + 120 * DAY);
    const health = await getDatasetHealth(store, WS, { now: oldest });

    const pricing = health.datasets.find((d) => d.type === "pricing");
    assert.ok(pricing);
    assert.equal(pricing.newestDataAgeDays, 120);
    assert.equal(pricing.stale, true);

    const staleAlert = health.alerts.find((a) => a.severity === "stale");
    assert.ok(staleAlert);
    assert.equal(staleAlert.message, "Your pricing dataset is 120 days old");
  });

  it("does not flag a dataset exactly at the threshold", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Our pricing starts at $10 per month for the starter plan.", type: "pricing" },
    ]);
    const chunks = await store.listAllChunks(WS);
    const atThreshold = new Date(chunks[0].createdAt.getTime() + 90 * DAY);
    const health = await getDatasetHealth(store, WS, { now: atThreshold });
    const pricing = health.datasets.find((d) => d.type === "pricing");
    assert.ok(pricing);
    assert.equal(pricing.stale, false);
    assert.ok(!health.alerts.some((a) => a.severity === "stale"));
  });

  it("alerts when classified chunks exist but nothing was compiled", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "What is your refund policy? We offer 30-day refunds.", type: "faq" },
      { text: "How do I reset my password? Go to settings.", type: "faq" },
    ]);
    const health = await getDatasetHealth(store, WS);
    const alert = health.alerts.find((a) => a.severity === "uncompiled");
    assert.ok(alert);
    assert.equal(alert.datasetType, "faq");
    assert.equal(
      alert.message,
      "Compile your first FAQ dataset from 2 classified chunks",
    );
  });

  it("detects drift: chunks classified after the latest compile", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Our pricing starts at $10 per month for the starter plan.", type: "pricing" },
    ]);
    // The in-memory store keeps records by reference: pin the first
    // chunk's arrival 60s in the past, and the compile 30s in the past,
    // so the next chunk deterministically counts as post-compile drift.
    const firstChunks = await store.listAllChunks(WS);
    assert.equal(firstChunks.length, 1);
    firstChunks[0].createdAt = new Date(Date.now() - 60_000);

    const { version } = await compileDataset(store, WS, "pricing");
    version.compiledAt = new Date(Date.now() - 30_000);

    await seedClassified(store, [
      { text: "The enterprise tier is $99 per month, billed annually.", type: "pricing" },
    ]);
    const health = await getDatasetHealth(store, WS);
    const pricing = health.datasets.find((d) => d.type === "pricing");
    assert.ok(pricing);
    assert.equal(pricing.chunksSinceCompile, 1);

    const drift = health.alerts.find((a) => a.severity === "drift");
    assert.ok(drift);
    assert.equal(
      drift.message,
      "1 new pricing chunk since v1 — recompile to refresh",
    );
  });

  it("freshly compiled datasets raise no alerts", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Our pricing starts at $10 per month for the starter plan.", type: "pricing" },
    ]);
    await compileDataset(store, WS, "pricing");
    const health = await getDatasetHealth(store, WS);
    assert.deepEqual(health.alerts, []);
    const pricing = health.datasets.find((d) => d.type === "pricing");
    assert.ok(pricing);
    assert.equal(pricing.latestVersion, 1);
    assert.equal(pricing.newestDataAgeDays, 0);
  });
});
