// Marketr — Phase 12: repurpose pipeline tests.
// Run: npx tsx --test lib/content/__tests__/repurpose.test.ts
// Injectable deps: no embedder, no live LLM, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { repurposeContent, REPURPOSE_FORMATS } from "../repurpose";
import type { RepurposeDeps } from "../repurpose";
import type { ExpertHit } from "@/lib/intelligence/corpus/types";

function testDeps(overrides: Partial<RepurposeDeps> = {}): RepurposeDeps {
  const hit: ExpertHit = {
    text: "Positioning is the act of designing the company's offering and image.",
    sourceTitle: "Positioning: The Battle for Your Mind",
    author: "Al Ries, Jack Trout",
    license: "public-domain",
  };
  return {
    retrieve: async () => [hit],
    generate: async (prompt: string) => `ASSET for prompt length ${prompt.length}`,
    live: true,
    ...overrides,
  };
}

describe("repurposeContent", () => {
  it("rejects an empty topic", async () => {
    await assert.rejects(
      repurposeContent({ topic: "   ", format: "brief" }, testDeps()),
      /topic is required/,
    );
  });

  it("rejects an unknown format", async () => {
    await assert.rejects(
      // @ts-expect-error — intentionally invalid
      repurposeContent({ topic: "positioning", format: "nope" }, testDeps()),
      /unknown format/,
    );
  });

  it("returns the asset with source citations", async () => {
    const res = await repurposeContent(
      { topic: "positioning", format: "social-thread" },
      testDeps(),
    );
    assert.equal(res.format, "social-thread");
    assert.equal(res.topic, "positioning");
    assert.match(res.asset, /ASSET/);
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0].title, "Positioning: The Battle for Your Mind");
    assert.equal(res.mock, false);
  });

  it("marks mock runs honestly", async () => {
    const res = await repurposeContent(
      { topic: "positioning", format: "newsletter" },
      testDeps({ live: false }),
    );
    assert.equal(res.mock, true);
  });

  it("handles zero corpus hits without crashing", async () => {
    const res = await repurposeContent(
      { topic: "obscure topic", format: "brief" },
      testDeps({ retrieve: async () => [] }),
    );
    assert.equal(res.sources.length, 0);
    assert.match(res.asset, /ASSET/);
  });

  it("exposes exactly the four approved formats", () => {
    assert.deepEqual(
      REPURPOSE_FORMATS.map((f) => f.id).sort(),
      ["brief", "newsletter", "social-thread", "video-script"].sort(),
    );
  });
});
