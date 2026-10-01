// Marketr — Dataset Builder slice 1 tests: pointer integrity.
// Run: npx tsx --test lib/datasetbuilder/__tests__/integrity.test.ts
//
// The zero-orphaned-chunks invariant, proven three ways:
//   1. positive: full ingests leave no orphans;
//   2. negative: the store REJECTS a chunk write with an unknown document id;
//   3. negative: the store REJECTS a document write with an unknown source id.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryDatasetBuilderStore } from "../store";
import { ingestPaste } from "../ingest";
import { getSourceRegister, verifyNoOrphanedChunks } from "../register";
import { DatasetBuilderError } from "../types";

const WS = "ws-integrity";

describe("verifyNoOrphanedChunks", () => {
  it("returns empty after ingesting across all source kinds", async () => {
    const store = makeStore();
    await ingestPaste(store, {
      workspaceId: WS,
      label: "notes",
      text: "one two three four five six seven eight nine ten",
    });
    await ingestPaste(store, {
      workspaceId: WS,
      label: "more notes",
      text: "alpha beta gamma delta epsilon zeta eta theta",
    });
    const orphans = await verifyNoOrphanedChunks(store, WS);
    assert.deepEqual(orphans, []);
  });

  it("rejects a chunk write with an unknown document id (negative)", async () => {
    const store = makeStore();
    await assert.rejects(
      () =>
        store.createChunk({
          workspaceId: WS,
          documentId: "doc-does-not-exist",
          position: 0,
          charStart: 0,
          charEnd: 5,
          text: "hello",
        }),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "ORPHAN_CHUNK_REJECTED",
    );
  });

  it("rejects a chunk write with a missing document pointer (negative)", async () => {
    const store = makeStore();
    await assert.rejects(
      () =>
        store.createChunk({
          workspaceId: WS,
          documentId: "",
          position: 0,
          charStart: 0,
          charEnd: 5,
          text: "hello",
        }),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "ORPHAN_CHUNK_REJECTED",
    );
  });

  it("rejects a document write with an unknown source id (negative)", async () => {
    const store = makeStore();
    await assert.rejects(
      () =>
        store.createDocument({
          workspaceId: WS,
          sourceId: "src-does-not-exist",
          name: "orphan doc",
        }),
      (e) => e instanceof DatasetBuilderError && e.code === "UNKNOWN_SOURCE",
    );
  });

  it("never reports chunks from another workspace", async () => {
    const store = makeStore();
    await ingestPaste(store, {
      workspaceId: "ws-other",
      label: "other notes",
      text: "totally separate workspace text here",
    });
    const orphans = await verifyNoOrphanedChunks(store, WS);
    assert.deepEqual(orphans, []);
  });
});

describe("getSourceRegister", () => {
  it("counts sources, documents, and chunks", async () => {
    const store = makeStore();
    const r1 = await ingestPaste(store, {
      workspaceId: WS,
      label: "notes",
      text: "word ".repeat(400),
      chunking: { chunkSize: 100, chunkOverlap: 10 },
    });
    const r2 = await ingestPaste(store, {
      workspaceId: WS,
      label: "short",
      text: "tiny",
    });

    const register = await getSourceRegister(store, WS);
    assert.equal(register.totals.sources, 2);
    assert.equal(register.totals.documents, 2);
    assert.equal(register.totals.chunks, r1.chunkCount + r2.chunkCount);
    assert.equal(register.totals.chars, r1.charCount + r2.charCount);

    const entry = register.entries.find((e) => e.source.id === r1.source.id)!;
    assert.equal(entry.documentCount, 1);
    assert.equal(entry.chunkCount, r1.chunkCount);
    assert.equal(entry.documents[0].document.id, r1.document.id);
    assert.equal(entry.documents[0].chunkCount, r1.chunkCount);
  });

  it("is empty for a workspace with no sources", async () => {
    const store = makeStore();
    const register = await getSourceRegister(store, "ws-empty");
    assert.deepEqual(register.totals, {
      sources: 0,
      documents: 0,
      chunks: 0,
      chars: 0,
    });
  });
});

function makeStore() {
  return new InMemoryDatasetBuilderStore();
}
