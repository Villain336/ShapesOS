// Marketr — Dataset Builder slice 3 tests: versioned compiler, lineage,
// exports (JSONL + Parquet), and the no-orphaned-snapshots audit.
// Run: npx tsx --test lib/datasetbuilder/__tests__/build.test.ts
//
// Under test: compiling applied classifications produces monotonic
// versions with per-chunk lineage back to Source/Document/Chunk; exports
// carry the lineage flat; nothing compiles from an empty classified set.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryDatasetBuilderStore } from "../store";
import { DATASET_TYPE_LABELS, type DatasetType } from "../classify";
import { ingestPaste } from "../ingest";
import {
  compileDataset,
  compileDatasets,
  exportDatasetJsonl,
  exportDatasetParquet,
  getVersionExportRows,
  getVersionLineage,
  verifyNoOrphanedVersionChunks,
} from "../build";
import { DatasetBuilderError } from "../types";
import { ParquetReader } from "@dsnp/parquetjs";

const WS = "ws-test";

/** Ingest one chunk per text, then apply classifications of given types. */
async function seedClassified(
  store: InMemoryDatasetBuilderStore,
  entries: { text: string; type: DatasetType; confidence?: number }[],
): Promise<string[]> {
  const chunkIds: string[] = [];
  for (const [i, entry] of entries.entries()) {
    const result = await ingestPaste(store, {
      workspaceId: WS,
      label: `seed-${i}`,
      text: entry.text,
    });
    const docChunks = await store.listChunksByDocument(result.document.id);
    assert.ok(docChunks.length >= 1, `expected chunks for seed-${i}`);
    const chunk = docChunks[0];
    chunkIds.push(chunk.id);
    await store.upsertClassification({
      workspaceId: WS,
      chunkId: chunk.id,
      datasetType: entry.type,
      confidence: entry.confidence ?? 0.9,
      engine: "rules",
      engineVersion: "rules-v1",
      status: "applied",
    });
  }
  return chunkIds;
}

describe("compileDataset", () => {
  it("creates the dataset on first compile and versions monotonically", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Our pricing starts at $10 per month for the starter plan.", type: "pricing" },
      { text: "The enterprise tier is $99 per month, billed annually.", type: "pricing" },
    ]);

    const first = await compileDataset(store, WS, "pricing");
    assert.equal(first.dataset.type, "pricing");
    assert.equal(first.dataset.name, DATASET_TYPE_LABELS.pricing);
    assert.equal(first.version.version, 1);
    assert.equal(first.version.chunkCount, 2);
    assert.equal(first.chunkCount, 2);
    assert.equal(first.version.settings.compiler, "dataset-compiler");
    assert.equal(first.version.settings.datasetType, "pricing");

    // New chunk classified → v2 picks it up, v1 unchanged.
    await seedClassified(store, [
      { text: "Add-ons cost $5 per month each, one-time setup is free.", type: "pricing" },
    ]);
    const second = await compileDataset(store, WS, "pricing");
    assert.equal(second.version.version, 2);
    assert.equal(second.chunkCount, 3);
    assert.equal(second.dataset.id, first.dataset.id);

    const v1Rows = await store.listDatasetVersionChunks(first.version.id);
    assert.equal(v1Rows.length, 2);
  });

  it("throws COMPILE_EMPTY when nothing is classified", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await ingestPaste(store, {
      workspaceId: WS,
      label: "unclassified",
      text: "Some text nobody classified yet.",
    });
    await assert.rejects(() => compileDataset(store, WS, "pricing"), (e) => {
      assert.ok(e instanceof DatasetBuilderError);
      assert.equal(e.code, "COMPILE_EMPTY");
      return true;
    });
  });

  it("includes only applied classifications, never pending or rejected", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "What is your refund policy? We offer 30-day refunds.", type: "faq" },
    ]);
    // A pending_review classification for another chunk must not compile.
    const pending = await ingestPaste(store, {
      workspaceId: WS,
      label: "pending",
      text: "Maybe a question? Hard to say with low confidence.",
    });
    const pendingChunks = await store.listChunksByDocument(pending.document.id);
    await store.upsertClassification({
      workspaceId: WS,
      chunkId: pendingChunks[0].id,
      datasetType: "faq",
      confidence: 0.3,
      engine: "rules",
      engineVersion: "rules-v1",
      status: "pending_review",
    });

    const result = await compileDataset(store, WS, "faq");
    assert.equal(result.chunkCount, 1);
  });

  it("dedupes one chunk classified by two engines (highest confidence wins)", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const [chunkId] = await seedClassified(store, [
      { text: "Our mission: help every team ship faster since 2019.", type: "company_fact", confidence: 0.7 },
    ]);
    await store.upsertClassification({
      workspaceId: WS,
      chunkId,
      datasetType: "company_fact",
      confidence: 0.95,
      engine: "frontier-api",
      engineVersion: "frontier-v1",
      status: "applied",
    });
    const result = await compileDataset(store, WS, "company_fact");
    assert.equal(result.chunkCount, 1);
    const lineage = await getVersionLineage(store, result.version.id);
    assert.equal(lineage.chunks[0].engine, "frontier-api");
    assert.equal(lineage.chunks[0].confidence, 0.95);
  });

  it("compileDatasets skips empty types and compiles the rest", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "How do I reset my password? Go to settings.", type: "faq" },
      { text: "Pricing is $29 per month for teams.", type: "pricing" },
    ]);
    const { compiled, skipped } = await compileDatasets(store, WS);
    const types = compiled.map((c) => c.dataset.type).sort();
    assert.deepEqual(types, ["faq", "pricing"]);
    assert.ok(skipped.includes("policy"));
    assert.ok(skipped.includes("product_catalog"));
  });
});

describe("lineage", () => {
  it("traces every version chunk back to source, document, and model", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Our pricing starts at $10 per month for the starter plan.", type: "pricing" },
      { text: "The enterprise tier is $99 per month, billed annually.", type: "pricing" },
    ]);
    const { version } = await compileDataset(store, WS, "pricing");
    const lineage = await getVersionLineage(store, version.id);

    assert.equal(lineage.chunks.length, 2);
    for (const c of lineage.chunks) {
      assert.ok(c.chunkId.length > 0);
      assert.ok(c.text.length > 0);
      assert.ok(c.documentName.length > 0);
      assert.ok(c.sourceName.startsWith("seed-"));
      assert.equal(c.engine, "rules");
      assert.equal(c.engineVersion, "rules-v1");
    }
    // Summaries add up to the chunk count.
    const sourceTotal = lineage.sources.reduce((n, s) => n + s.chunkCount, 0);
    assert.equal(sourceTotal, 2);
    const engineTotal = lineage.engines.reduce((n, e) => n + e.chunkCount, 0);
    assert.equal(engineTotal, 2);
    assert.equal(lineage.version.settings.compiler, "dataset-compiler");
  });

  it("throws UNKNOWN_DATASET_VERSION for a missing version", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await assert.rejects(() => getVersionLineage(store, "nope"), (e) => {
      assert.ok(e instanceof DatasetBuilderError);
      assert.equal(e.code, "UNKNOWN_DATASET_VERSION");
      return true;
    });
  });

  it("verifyNoOrphanedVersionChunks is clean after compiles", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "How do I reset my password? Go to settings.", type: "faq" },
      { text: "Pricing is $29 per month for teams.", type: "pricing" },
    ]);
    await compileDatasets(store, WS);
    assert.deepEqual(await verifyNoOrphanedVersionChunks(store, WS), []);
  });
});

describe("store guards", () => {
  it("createDatasetVersion rejects unknown datasets and duplicate versions", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await assert.rejects(
      () =>
        store.createDatasetVersion({
          workspaceId: WS,
          datasetId: "nope",
          version: 1,
          chunkCount: 0,
          settings: { compiler: "x", compilerVersion: "1", datasetType: "faq" },
        }),
      (e) => {
        assert.ok(e instanceof DatasetBuilderError);
        assert.equal(e.code, "UNKNOWN_DATASET");
        return true;
      },
    );

    const dataset = await store.getOrCreateDataset(WS, "faq");
    await store.createDatasetVersion({
      workspaceId: WS,
      datasetId: dataset.id,
      version: 1,
      chunkCount: 0,
      settings: { compiler: "x", compilerVersion: "1", datasetType: "faq" },
    });
    await assert.rejects(
      () =>
        store.createDatasetVersion({
          workspaceId: WS,
          datasetId: dataset.id,
          version: 1,
          chunkCount: 0,
          settings: { compiler: "x", compilerVersion: "1", datasetType: "faq" },
        }),
      (e) => {
        assert.ok(e instanceof DatasetBuilderError);
        assert.equal(e.code, "DATASET_VERSION_EXISTS");
        return true;
      },
    );
  });

  it("addDatasetVersionChunks rejects dangling pointers and skips retries", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const dataset = await store.getOrCreateDataset(WS, "faq");
    const version = await store.createDatasetVersion({
      workspaceId: WS,
      datasetId: dataset.id,
      version: 1,
      chunkCount: 1,
      settings: { compiler: "x", compilerVersion: "1", datasetType: "faq" },
    });

    await assert.rejects(
      () =>
        store.addDatasetVersionChunks([
          {
            workspaceId: WS,
            versionId: version.id,
            chunkId: "nope",
            classificationId: "nope",
            engine: "rules",
            engineVersion: "rules-v1",
          },
        ]),
      (e) => {
        assert.ok(e instanceof DatasetBuilderError);
        assert.equal(e.code, "UNKNOWN_CHUNK");
        return true;
      },
    );
    await assert.rejects(
      () =>
        store.addDatasetVersionChunks([
          {
            workspaceId: WS,
            versionId: "nope",
            chunkId: "nope",
            classificationId: "nope",
            engine: "rules",
            engineVersion: "rules-v1",
          },
        ]),
      (e) => {
        assert.ok(e instanceof DatasetBuilderError);
        assert.equal(e.code, "UNKNOWN_DATASET_VERSION");
        return true;
      },
    );

    // Valid rows: written once, retry skipped.
    const [chunkId] = await seedClassified(store, [
      { text: "What are your hours? We are open 9 to 5.", type: "faq" },
    ]);
    const classification = await store.getClassificationByChunk(chunkId);
    assert.ok(classification);
    const rows = [
      {
        workspaceId: WS,
        versionId: version.id,
        chunkId,
        classificationId: classification.id,
        engine: "rules",
        engineVersion: "rules-v1",
      },
    ];
    const first = await store.addDatasetVersionChunks(rows);
    const second = await store.addDatasetVersionChunks(rows);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(second[0].id, first[0].id);
    assert.equal((await store.listDatasetVersionChunks(version.id)).length, 1);
  });

  it("addDatasetVersionChunks rejects a dangling classification pointer", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const dataset = await store.getOrCreateDataset(WS, "faq");
    const version = await store.createDatasetVersion({
      workspaceId: WS,
      datasetId: dataset.id,
      version: 1,
      chunkCount: 1,
      settings: { compiler: "x", compilerVersion: "1", datasetType: "faq" },
    });
    const [chunkId] = await seedClassified(store, [
      { text: "What are your hours? We are open 9 to 5.", type: "faq" },
    ]);
    await assert.rejects(
      () =>
        store.addDatasetVersionChunks([
          {
            workspaceId: WS,
            versionId: version.id,
            chunkId,
            classificationId: "missing-classification",
            engine: "rules",
            engineVersion: "rules-v1",
          },
        ]),
      (e) => {
        assert.ok(e instanceof DatasetBuilderError);
        assert.equal(e.code, "UNKNOWN_CLASSIFICATION");
        return true;
      },
    );
  });
});

describe("exports", () => {
  it("JSONL export is one valid object per line with lineage fields", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Our pricing starts at $10 per month for the starter plan.", type: "pricing" },
      { text: "The enterprise tier is $99 per month, billed annually.", type: "pricing" },
    ]);
    const { version } = await compileDataset(store, WS, "pricing");
    const rows = await getVersionExportRows(store, version.id);
    assert.equal(rows.length, 2);

    const jsonl = exportDatasetJsonl(rows);
    const lines = jsonl.trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const obj = JSON.parse(line);
      assert.equal(obj.dataset_type, "pricing");
      assert.equal(obj.compiled_version, 1);
      assert.ok(obj.chunk_id);
      assert.ok(obj.text);
      assert.ok(obj.source_id);
      assert.ok(obj.source_name);
      assert.ok(obj.document_id);
      assert.ok(obj.classification_engine);
      assert.ok(typeof obj.confidence === "number");
    }
    // Deterministic key order across rows.
    const keys = Object.keys(JSON.parse(lines[0]));
    assert.deepEqual(keys, Object.keys(JSON.parse(lines[1])));
  });

  it("Parquet export is a real parquet file and round-trips through the reader", async () => {
    const store = new InMemoryDatasetBuilderStore();
    await seedClassified(store, [
      { text: "Our pricing starts at $10 per month for the starter plan.", type: "pricing" },
      { text: "The enterprise tier is $99 per month, billed annually.", type: "pricing" },
    ]);
    const { version } = await compileDataset(store, WS, "pricing");
    const rows = await getVersionExportRows(store, version.id);

    const buf = await exportDatasetParquet(rows);
    // Parquet magic bytes: PAR1 … PAR1.
    assert.equal(buf.subarray(0, 4).toString("ascii"), "PAR1");
    assert.equal(buf.subarray(buf.length - 4).toString("ascii"), "PAR1");

    // ParquetReader.openFile claims Buffer support in its types, but
    // 1.8.9 stats the argument as a path — round-trip via a temp file.
    const { promises: fsp } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = join(tmpdir(), `dataset-readback-${Date.now()}.parquet`);
    await fsp.writeFile(tmp, buf);
    const reader = await ParquetReader.openFile(tmp);
    const cursor = reader.getCursor();
    const read: Record<string, unknown>[] = [];
    for (;;) {
      const record: unknown = await cursor.next();
      if (record === null || record === undefined) break;
      read.push(record as Record<string, unknown>);
    }
    await reader.close();
    await fsp.unlink(tmp).catch(() => undefined);

    assert.equal(read.length, 2);
    const texts = read.map((r) => r.text).sort();
    assert.deepEqual(texts, rows.map((r) => r.text).sort());
    for (const r of read) {
      assert.equal(r.dataset_type, "pricing");
      assert.equal(r.compiled_version, 1);
      assert.ok(r.chunk_id);
      assert.ok(r.source_name);
    }
  });
});
