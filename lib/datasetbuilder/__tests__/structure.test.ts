// Marketr — Dataset Builder slice 2 tests: structure pipeline + review flow.
// Run: npx tsx --test lib/datasetbuilder/__tests__/structure.test.ts
//
// The trust-ladder rule under test: low-confidence classifications NEVER
// auto-apply — they create exactly one ReviewItem each, and a rejected
// review leaves the chunk unclassified rather than mislabeled.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryDatasetBuilderStore } from "../store";
import {
  DEFAULT_CLASSIFICATION_THRESHOLD,
  RulesClassificationEngine,
  type ClassificationEngine,
  type ClassificationOutput,
  type DatasetType,
} from "../classify";
import { ingestPaste } from "../ingest";
import {
  decideReview,
  getTypeBreakdown,
  listReviewQueue,
  structureChunk,
  structureDocument,
} from "../structure";
import { DatasetBuilderError } from "../types";

const WS = "ws-test";

/** Stub engine: fixed output per call, for deterministic routing tests. */
class StubEngine implements ClassificationEngine {
  readonly name = "stub";
  readonly version = "stub-v1";
  constructor(
    private readonly outputs: ClassificationOutput[],
    private cursor = 0,
  ) {}
  async classify(_text: string): Promise<ClassificationOutput> {
    const out = this.outputs[this.cursor % this.outputs.length];
    this.cursor += 1;
    return out;
  }
}

async function seedChunks(
  store: InMemoryDatasetBuilderStore,
  texts: string[],
) {
  // One paste per text: short texts would otherwise merge into a single
  // 1000-char chunk, and these tests need one chunk per input text.
  const chunks = [];
  for (const [i, text] of texts.entries()) {
    const result = await ingestPaste(store, {
      workspaceId: WS,
      label: `seed-${i}`,
      text,
    });
    const docChunks = await store.listChunksByDocument(result.document.id);
    assert.ok(docChunks.length >= 1, `expected chunks for seed-${i}`);
    chunks.push(docChunks[0]);
  }
  return chunks;
}

describe("structureChunk routing", () => {
  it("auto-applies high-confidence classifications without a review item", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const chunks = await seedChunks(store, ["some pricing text here"]);
    const engine = new StubEngine([{ type: "pricing", confidence: 0.95 }]);
    const res = await structureChunk(store, engine, chunks[0]);
    assert.equal(res.classification.status, "applied");
    assert.equal(res.classification.datasetType, "pricing");
    assert.equal(res.reviewItemId, null);
    const pending = await store.listReviewItems(WS, "pending");
    assert.equal(pending.length, 0);
  });

  it("routes low-confidence classifications to exactly one review item", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const chunks = await seedChunks(store, ["ambiguous text here"]);
    const engine = new StubEngine([{ type: "policy", confidence: 0.4 }]);
    const res = await structureChunk(store, engine, chunks[0]);
    assert.equal(res.classification.status, "pending_review");
    assert.ok(res.reviewItemId, "expected a review item id");
    const pending = await store.listReviewItems(WS, "pending");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, res.reviewItemId);
  });

  it("re-running the same engine replaces, never duplicates", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const chunks = await seedChunks(store, ["text"]);
    const engine = new StubEngine([{ type: "faq", confidence: 0.9 }]);
    await structureChunk(store, engine, chunks[0]);
    await structureChunk(store, engine, chunks[0]);
    const byType = await store.listClassificationsByType(WS, "faq");
    assert.equal(byType.length, 1);
  });

  it("rejects classifications of unknown chunks", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const engine = new StubEngine([{ type: "faq", confidence: 0.9 }]);
    await assert.rejects(
      () =>
        store.upsertClassification({
          workspaceId: WS,
          chunkId: "chunk-missing",
          datasetType: "faq",
          confidence: 0.9,
          engine: engine.name,
          engineVersion: engine.version,
        }),
      (e: unknown) =>
        e instanceof DatasetBuilderError && e.code === "UNKNOWN_CHUNK",
    );
  });
});

describe("review decisions", () => {
  async function pendingReview() {
    const store = new InMemoryDatasetBuilderStore();
    const chunks = await seedChunks(store, ["ambiguous text here"]);
    const engine = new StubEngine([{ type: "policy", confidence: 0.4 }]);
    const res = await structureChunk(store, engine, chunks[0]);
    assert.ok(res.reviewItemId);
    return { store, reviewId: res.reviewItemId };
  }

  it("approve applies the suggested type", async () => {
    const { store, reviewId } = await pendingReview();
    const { classification, appliedType } = await decideReview(store, reviewId, {
      action: "approve",
    });
    assert.equal(classification.status, "applied");
    assert.equal(classification.datasetType, "policy");
    assert.equal(appliedType, "policy");
    const review = await store.getReviewItem(reviewId);
    assert.equal(review?.status, "approved");
    assert.ok(review?.decidedAt);
  });

  it("reassign applies the human's type", async () => {
    const { store, reviewId } = await pendingReview();
    const { classification, appliedType } = await decideReview(store, reviewId, {
      action: "reassign",
      datasetType: "pricing",
    });
    assert.equal(classification.status, "applied");
    assert.equal(classification.datasetType, "pricing");
    assert.equal(appliedType, "pricing");
  });

  it("reject leaves the chunk unclassified — never mislabeled", async () => {
    const { store, reviewId } = await pendingReview();
    const { classification, appliedType } = await decideReview(store, reviewId, {
      action: "reject",
    });
    assert.equal(classification.status, "rejected");
    assert.equal(appliedType, null);
    const review = await store.getReviewItem(reviewId);
    assert.equal(review?.status, "rejected");
  });

  it("reassign without a type is a validation error", async () => {
    const { store, reviewId } = await pendingReview();
    await assert.rejects(
      () => decideReview(store, reviewId, { action: "reassign" }),
      (e: unknown) =>
        e instanceof DatasetBuilderError && e.code === "VALIDATION_FAILED",
    );
  });

  it("decisions are final — re-deciding throws", async () => {
    const { store, reviewId } = await pendingReview();
    await decideReview(store, reviewId, { action: "approve" });
    await assert.rejects(
      () => decideReview(store, reviewId, { action: "reject" }),
      (e: unknown) =>
        e instanceof DatasetBuilderError && e.code === "REVIEW_ALREADY_DECIDED",
    );
  });

  it("duplicate review items are rejected", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const chunks = await seedChunks(store, ["text"]);
    const classification = await store.upsertClassification({
      workspaceId: WS,
      chunkId: chunks[0].id,
      datasetType: "faq",
      confidence: 0.3,
      engine: "stub",
      engineVersion: "stub-v1",
      status: "pending_review",
    });
    await store.createReviewItem({
      workspaceId: WS,
      classificationId: classification.id,
    });
    await assert.rejects(
      () =>
        store.createReviewItem({
          workspaceId: WS,
          classificationId: classification.id,
        }),
      (e: unknown) =>
        e instanceof DatasetBuilderError && e.code === "REVIEW_ALREADY_EXISTS",
    );
  });
});

describe("structureDocument with the rules engine", () => {
  it("structures a mixed document: every chunk applied or queued, none lost", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const engine = new RulesClassificationEngine();
    const chunks = await seedChunks(store, [
      "Q: How do I reset my password? A: Use the forgot-password link on the sign-in page.",
      "Starter plan: $29 per month billed annually. Growth plan: $79 per month.",
      "The thing is fine and stuff happens sometimes in various ways.",
    ]);
    const results = [];
    for (const chunk of chunks) {
      results.push(await structureChunk(store, engine, chunk));
    }
    assert.equal(results.length, chunks.length);

    // Invariant: every chunk is either applied or has exactly one pending review.
    for (const chunk of chunks) {
      const c = await store.getClassificationByChunk(chunk.id);
      assert.ok(c, `chunk ${chunk.id} has no classification`);
      if (c.status === "pending_review") {
        const item = await store.getReviewItemByClassification(c.id);
        assert.ok(item, `pending classification ${c.id} has no review item`);
      }
    }

    const breakdown = await getTypeBreakdown(store, WS);
    const appliedTotal = Object.values(breakdown.byType).reduce(
      (a, b) => a + b,
      0,
    );
    assert.equal(
      appliedTotal + breakdown.pendingReview + breakdown.unclassified,
      chunks.length,
    );
  });

  it("the review queue carries chunk text + document/source names", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const chunks = await seedChunks(store, [
      "The thing is fine and stuff happens sometimes in various ways.",
    ]);
    const engine = new StubEngine([{ type: "faq", confidence: 0.2 }]);
    await structureChunk(store, engine, chunks[0]);
    const queue = await listReviewQueue(store, WS);
    assert.equal(queue.length, 1);
    assert.ok(queue[0].chunkText.length > 0);
    assert.equal(queue[0].documentName, "seed-0");
    assert.equal(queue[0].sourceName, "seed-0");
    assert.equal(queue[0].classification.datasetType, "faq");
  });
});

describe("type breakdown", () => {
  it("counts applied per type and excludes pending/rejected", async () => {
    const store = new InMemoryDatasetBuilderStore();
    const chunks = await seedChunks(store, ["a", "b", "c"]);
    const engine = new StubEngine([
      { type: "pricing", confidence: 0.95 },
      { type: "faq", confidence: 0.2 },
      { type: "policy", confidence: 0.9 },
    ]);
    for (const chunk of chunks) {
      await structureChunk(store, engine, chunk);
    }
    const breakdown = await getTypeBreakdown(store, WS);
    assert.equal(breakdown.byType.pricing, 1);
    assert.equal(breakdown.byType.policy, 1);
    assert.equal(breakdown.byType.faq, 0);
    assert.equal(breakdown.pendingReview, 1);
    assert.equal(breakdown.unclassified, 0);
    assert.equal(
      breakdown.workspaceId,
      WS,
      "breakdown carries the workspace id",
    );
    void DEFAULT_CLASSIFICATION_THRESHOLD;
  });
});
