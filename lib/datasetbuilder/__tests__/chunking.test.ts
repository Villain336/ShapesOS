// Marketr — Dataset Builder slice 1 tests: chunking boundaries + metadata.
// Run: npx tsx --test lib/datasetbuilder/__tests__/chunking.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { chunkInputsForDocument, chunkText } from "../chunking";
import {
  DEFAULT_CHUNKING_CONFIG,
  DatasetBuilderError,
  validateChunkingConfig,
} from "../types";

const paragraph = (n: number) =>
  `Paragraph ${n} explains how the business works. It has several sentences. Each one adds detail. `.repeat(
    6,
  );

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    const chunks = chunkText("hello world");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].position, 0);
    assert.equal(chunks[0].charStart, 0);
    assert.equal(chunks[0].text, "hello world");
  });

  it("splits long text into bounded windows with positions", () => {
    const text = [0, 1, 2, 3, 4, 5, 6, 7].map(paragraph).join("\n\n");
    const chunks = chunkText(text, { chunkSize: 200, chunkOverlap: 40 });
    assert.ok(chunks.length > 1, "expected multiple chunks");
    chunks.forEach((c, i) => {
      assert.equal(c.position, i, "positions are sequential");
      assert.ok(c.text.length <= 200, `chunk ${i} exceeds chunkSize`);
      assert.ok(c.charStart < c.charEnd, "charStart < charEnd");
    });
  });

  it("overlaps consecutive chunks", () => {
    const text = "word ".repeat(500);
    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 20 });
    assert.ok(chunks.length > 1);
    const tail = chunks[0].text.slice(-20);
    assert.ok(
      chunks[1].text.includes(tail.slice(0, 10)),
      "chunk 1 should overlap the tail of chunk 0",
    );
    // char ranges overlap by design.
    assert.ok(chunks[1].charStart < chunks[0].charEnd);
  });

  it("keeps char offsets truthful to the source text", () => {
    const text = [0, 1, 2].map(paragraph).join("\n\n");
    const chunks = chunkText(text, { chunkSize: 150, chunkOverlap: 30 });
    for (const c of chunks) {
      const slice = text.slice(c.charStart, c.charEnd).trim();
      assert.equal(c.text, slice, "chunk text matches its char offsets");
    }
  });

  it("prefers paragraph boundaries", () => {
    const paras = ["alpha para", "beta para", "gamma para"].map((p) =>
      p.padEnd(60, "."),
    );
    const text = paras.join("\n\n");
    const chunks = chunkText(text, { chunkSize: 70, chunkOverlap: 0 });
    assert.ok(chunks.length >= 2);
    assert.ok(
      !chunks[0].text.includes("beta"),
      "first chunk should end at the paragraph break",
    );
  });

  it("rejects invalid configs", () => {
    assert.throws(
      () => validateChunkingConfig({ chunkSize: 0, chunkOverlap: 0 }),
      (e) => e instanceof DatasetBuilderError && e.code === "INVALID_CHUNKING_CONFIG",
    );
    assert.throws(
      () => validateChunkingConfig({ chunkSize: 100, chunkOverlap: 100 }),
      (e) => e instanceof DatasetBuilderError && e.code === "INVALID_CHUNKING_CONFIG",
    );
  });

  it("uses the default config when none is given", () => {
    assert.deepEqual(
      { chunkSize: DEFAULT_CHUNKING_CONFIG.chunkSize },
      { chunkSize: 1000 },
    );
  });
});

describe("chunkInputsForDocument", () => {
  it("stamps every chunk with the document pointer", () => {
    const inputs = chunkInputsForDocument("ws-1", "doc-1", "one two three", {
      chunkSize: 10,
      chunkOverlap: 2,
    });
    assert.ok(inputs.length > 0);
    for (const input of inputs) {
      assert.equal(input.documentId, "doc-1");
      assert.equal(input.workspaceId, "ws-1");
      assert.ok(typeof input.position === "number");
    }
  });

  it("refuses to build chunks without a document pointer (negative)", () => {
    assert.throws(
      () => chunkInputsForDocument("ws-1", "", "some text"),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "ORPHAN_CHUNK_REJECTED",
    );
  });
});
