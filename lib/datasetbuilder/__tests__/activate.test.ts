// Marketr — Dataset Builder slice 4 tests: Activate.
// Run: npx tsx --test lib/datasetbuilder/__tests__/activate.test.ts
//
// Under test: publishing compiled versions to the BriefNow connector
// (adapter package with full Source → Document → Chunk lineage) and to
// the OS RAG/Feed layer (pinned snapshot + grounded ask with citations);
// publish invariants (no version to publish fails, idempotent republishes,
// stale detection); grounded ask never invents content.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryDatasetBuilderStore } from "../store";
import { ingestPaste } from "../ingest";
import { compileDataset } from "../build";
import {
  askDataset,
  buildBriefNowAdapterPackage,
  getPublishStatus,
  publishDataset,
  resolveVersionEntries,
  type AdapterWriter,
} from "../activate";
import {
  DatasetBuilderError,
  type BriefNowAdapterPackage,
  type DatasetType,
} from "../types";

const WS = "ws-activate";

/** Fake adapter writer: captures packages in memory, touches no disk. */
function fakeWriter() {
  const written = new Map<string, BriefNowAdapterPackage>();
  const writer: AdapterWriter = {
    async write(relativePath, pkg) {
      written.set(relativePath, pkg);
      return `/adapters/${relativePath}`;
    },
  };
  return { writer, written };
}

/** One applied chunk per text entry, like build.test.ts. */
async function seedClassified(
  store: InMemoryDatasetBuilderStore,
  entries: { text: string; type: DatasetType; confidence?: number }[],
): Promise<void> {
  for (const [i, entry] of entries.entries()) {
    const result = await ingestPaste(store, {
      workspaceId: WS,
      label: `seed-${i}`,
      text: entry.text,
    });
    const docChunks = await store.listChunksByDocument(result.document.id);
    assert.ok(docChunks.length >= 1, `expected chunks for seed-${i}`);
    await store.upsertClassification({
      workspaceId: WS,
      chunkId: docChunks[0].id,
      datasetType: entry.type,
      confidence: entry.confidence ?? 0.9,
      engine: "rules",
      engineVersion: "rules-v1",
      status: "applied",
    });
  }
}

describe("publishDataset", () => {
  it("refuses to publish when nothing is compiled", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const dataset = await store.getOrCreateDataset(WS, "faq");
    const { writer } = fakeWriter();
    await assert.rejects(
      () =>
        publishDataset(store, {
          workspaceId: WS,
          datasetId: dataset.id,
          target: "briefnow",
          adapterWriter: writer,
        }),
      (e: unknown) =>
        e instanceof DatasetBuilderError &&
        e.code === "NO_VERSION_TO_PUBLISH",
    );
  });

  it("rejects unknown targets", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const dataset = await store.getOrCreateDataset(WS, "faq");
    const { writer } = fakeWriter();
    await assert.rejects(
      () =>
        publishDataset(store, {
          workspaceId: WS,
          datasetId: dataset.id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          target: "s3" as any,
          adapterWriter: writer,
        }),
      (e: unknown) =>
        e instanceof DatasetBuilderError &&
        e.code === "INVALID_PUBLISH_TARGET",
    );
  });

  it("publishes to briefnow with a full-lineage adapter package", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "What are your hours? We are open Monday to Friday, 9am to 5pm.", type: "faq" },
      { text: "Do you offer refunds? Yes, within 30 days of purchase.", type: "faq" },
    ]);
    const compiled = await compileDataset(store, WS, "faq");
    const { writer, written } = fakeWriter();

    const { record, adapterPackage } = await publishDataset(store, {
      workspaceId: WS,
      datasetId: compiled.dataset.id,
      target: "briefnow",
      adapterWriter: writer,
    });

    assert.equal(record.version, 1);
    assert.equal(record.target, "briefnow");
    assert.equal(record.chunkCount, 2);
    assert.ok(record.artifactRef.startsWith("/adapters/"));

    assert.ok(adapterPackage);
    assert.equal(adapterPackage.contract, "briefnow-dataset-adapter/v1");
    assert.equal(adapterPackage.datasetType, "faq");
    assert.equal(adapterPackage.datasetVersion, 1);
    assert.equal(adapterPackage.entries.length, 2);
    for (const entry of adapterPackage.entries) {
      assert.ok(entry.chunkId);
      assert.ok(entry.documentName.startsWith("seed-"));
      assert.ok(entry.sourceName.startsWith("seed-"));
      assert.ok(entry.sourceId);
      assert.ok(entry.documentId);
      assert.equal(entry.classification.engine, "rules");
      assert.equal(entry.classification.engineVersion, "rules-v1");
      assert.ok(entry.text.length > 0);
    }
    // The writer received exactly the package we shipped.
    assert.equal(written.size, 1);
    assert.deepEqual([...written.values()][0], adapterPackage);
  });

  it("republishing the same version+target is idempotent", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Our returns policy is generous: 60 days, no questions asked.", type: "faq" },
    ]);
    const compiled = await compileDataset(store, WS, "faq");
    const { writer } = fakeWriter();
    const opts = {
      workspaceId: WS,
      datasetId: compiled.dataset.id,
      target: "rag" as const,
      adapterWriter: writer,
    };
    const first = await publishDataset(store, opts);
    const second = await publishDataset(store, opts);
    assert.equal(first.record.id, second.record.id);
    const all = await store.listPublishRecords(compiled.dataset.id);
    assert.equal(all.length, 1);
  });

  it("publishes to rag with a snapshot pointer, no adapter file", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Acme was founded in 2019 in Raleigh, North Carolina.", type: "company_fact" },
    ]);
    const compiled = await compileDataset(store, WS, "company_fact");
    const { writer, written } = fakeWriter();

    const { record, adapterPackage } = await publishDataset(store, {
      workspaceId: WS,
      datasetId: compiled.dataset.id,
      target: "rag",
      adapterWriter: writer,
    });

    assert.equal(record.target, "rag");
    assert.equal(record.artifactRef, `rag://${WS}/company_fact/v1`);
    assert.equal(adapterPackage, undefined);
    assert.equal(written.size, 0);
  });
});

describe("getPublishStatus", () => {
  it("reports stale when a newer version exists than what is live", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Starter plan is $10 per month, billed monthly.", type: "pricing" },
    ]);
    const compiled = await compileDataset(store, WS, "pricing");
    const { writer } = fakeWriter();
    await publishDataset(store, {
      workspaceId: WS,
      datasetId: compiled.dataset.id,
      target: "briefnow",
      adapterWriter: writer,
    });

    // New data → v2 compiled, not yet published.
    await seedClassified(store, [
      { text: "Growth plan is $29 per month with priority support.", type: "pricing" },
    ]);
    await compileDataset(store, WS, "pricing");

    const { targets } = await getPublishStatus(store, WS, compiled.dataset.id);
    const briefnow = targets.find((t) => t.target === "briefnow");
    const rag = targets.find((t) => t.target === "rag");
    assert.ok(briefnow?.published);
    assert.equal(briefnow.version, 1);
    assert.equal(briefnow.latestVersion, 2);
    assert.equal(briefnow.stale, true);
    assert.equal(rag?.published, false);
    assert.equal(rag?.stale, false);
  });

  it("reports unpublished cleanly on a fresh dataset", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const dataset = await store.getOrCreateDataset(WS, "policy");
    const { targets } = await getPublishStatus(store, WS, dataset.id);
    for (const t of targets) {
      assert.equal(t.published, false);
      assert.equal(t.stale, false);
      assert.equal(t.latestVersion, null);
    }
  });
});

describe("resolveVersionEntries", () => {
  it("refuses to resolve when a version chunk points at a missing chunk", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Employees get 20 vacation days per year.", type: "policy" },
    ]);
    const compiled = await compileDataset(store, WS, "policy");
    // Force a dangling pointer the way a manual DB delete could: remove
    // the chunk from the store's private map.
    const chunks = await store.listAllChunks(WS);
    const internals = store as unknown as {
      chunks: Map<string, unknown>;
    };
    internals.chunks.delete(chunks[0].id);
    await assert.rejects(
      () => resolveVersionEntries(store, WS, compiled.version.id),
      (e: unknown) =>
        e instanceof DatasetBuilderError && e.code === "LINEAGE_BROKEN",
    );
  });
});

describe("buildBriefNowAdapterPackage", () => {
  it("is deterministic: same inputs, same entry order", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Zebra fact: zebras are striped.", type: "company_fact" },
      { text: "Apple fact: apples are fruit.", type: "company_fact" },
    ]);
    const compiled = await compileDataset(store, WS, "company_fact");
    const entries = await resolveVersionEntries(
      store,
      WS,
      compiled.version.id,
    );
    // Fixed publish time: two builds in the same test can straddle a
    // millisecond (flaked in CI on publishedAt alone).
    const at = new Date("2026-10-04T00:00:00.000Z");
    const a = buildBriefNowAdapterPackage(compiled.dataset, 1, entries, at);
    const b = buildBriefNowAdapterPackage(compiled.dataset, 1, entries, at);
    assert.deepEqual(a, b);
    assert.deepEqual(
      a.entries.map((e) => e.documentName),
      ["seed-0", "seed-1"],
    );
  });
});

describe("askDataset", () => {
  it("answers from the dataset and cites source, document, and chunk", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Our pricing starts at $10 per month for the starter plan.", type: "pricing" },
      { text: "The enterprise tier is $99 per month, billed annually.", type: "pricing" },
    ]);
    const compiled = await compileDataset(store, WS, "pricing");
    const { writer } = fakeWriter();
    await publishDataset(store, {
      workspaceId: WS,
      datasetId: compiled.dataset.id,
      target: "rag",
      adapterWriter: writer,
    });

    const result = await askDataset(
      store,
      WS,
      compiled.dataset.id,
      "How much does the starter plan cost per month?",
    );

    assert.equal(result.grounded, true);
    assert.ok(result.answer.includes("starter plan"));
    assert.equal(result.confidence, "high");
    assert.equal(result.datasetVersion, 1);
    // The starter-plan chunk wins; the enterprise chunk may also cite.
    assert.ok(result.citations.length >= 1);
    const [citation] = result.citations;
    assert.ok(citation.excerpt.includes("starter plan"));
    assert.ok(citation.chunkId);
    assert.ok(citation.documentId);
    assert.ok(citation.documentName.startsWith("seed-"));
    assert.ok(citation.sourceId);
    assert.ok(citation.sourceName.startsWith("seed-"));
    assert.ok(citation.excerpt.length > 0);
    assert.equal(citation.engine, "rules");
    assert.equal(citation.datasetVersion, 1);
  });

  it("refuses to guess when nothing matches — zero ungrounded content", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Our pricing starts at $10 per month for the starter plan.", type: "pricing" },
    ]);
    const compiled = await compileDataset(store, WS, "pricing");

    const result = await askDataset(
      store,
      WS,
      compiled.dataset.id,
      "What is the weather on Mars today?",
    );

    assert.equal(result.grounded, false);
    assert.equal(result.citations.length, 0);
    assert.equal(result.confidence, "low");
    // The refusal names where it looked — no invented facts.
    assert.ok(result.answer.includes("Pricing"));
    assert.ok(result.answer.includes("v1"));
  });

  it("asks the rag-published version, not just the latest compile", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Starter plan is $10 per month, billed monthly.", type: "pricing" },
    ]);
    const compiled = await compileDataset(store, WS, "pricing");
    const { writer } = fakeWriter();
    await publishDataset(store, {
      workspaceId: WS,
      datasetId: compiled.dataset.id,
      target: "rag",
      adapterWriter: writer,
    });

    // v2 compiled but NOT published to rag — ask must stay on v1.
    await seedClassified(store, [
      { text: "Growth plan is $29 per month with priority support.", type: "pricing" },
    ]);
    await compileDataset(store, WS, "pricing");

    const result = await askDataset(
      store,
      WS,
      compiled.dataset.id,
      "How much is the starter plan per month?",
    );
    assert.equal(result.datasetVersion, 1);
    assert.ok(result.answer.includes("Starter plan is $10"));
  });

  it("rejects empty questions", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const dataset = await store.getOrCreateDataset(WS, "faq");
    await assert.rejects(
      () => askDataset(store, WS, dataset.id, "   "),
      (e: unknown) =>
        e instanceof DatasetBuilderError && e.code === "VALIDATION_FAILED",
    );
  });
});

describe("store publish records", () => {
  it("validates version and dataset", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await assert.rejects(
      () =>
        store.createPublishRecord({
          workspaceId: WS,
          datasetId: "nope",
          target: "rag",
          version: 1,
          versionId: "nope",
          chunkCount: 0,
          artifactRef: "rag://x",
        }),
      (e: unknown) =>
        e instanceof DatasetBuilderError && e.code === "UNKNOWN_DATASET",
    );
    const dataset = await store.getOrCreateDataset(WS, "faq");
    await assert.rejects(
      () =>
        store.createPublishRecord({
          workspaceId: WS,
          datasetId: dataset.id,
          target: "rag",
          version: 0,
          versionId: "x",
          chunkCount: 0,
          artifactRef: "rag://x",
        }),
      (e: unknown) =>
        e instanceof DatasetBuilderError && e.code === "VALIDATION_FAILED",
    );
  });
});
