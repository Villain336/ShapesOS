// Marketr — Knowledge Brain: graph-data shaping tests.
// Run: npx tsx --test lib/intelligence/corpus/__tests__/graph.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCorpusGraph, type ProposedSource } from "../graph";
import type { CorpusManifest, CorpusSourceRecord } from "../types";

function rec(partial: Partial<CorpusSourceRecord> & { id: string }): CorpusSourceRecord {
  return {
    title: partial.id,
    author: "Someone",
    tier: 2,
    license: "CC-BY-4.0",
    licenseUrl: "",
    sourceUrl: "",
    status: "active",
    mode: "verbatim",
    chunks: 10,
    version: 7,
    retrievedDate: "2026-09-26",
    segregatedAsset: false,
    ...partial,
  };
}

function manifest(sources: CorpusSourceRecord[]): CorpusManifest {
  return {
    corpusVersion: 7,
    updatedAt: "2026-09-26T00:00:00Z",
    assets: { main: 100, "by-sa": 0 },
    sources,
    evalPrecision: 1,
    evalRunAt: "2026-09-26T00:00:00Z",
  };
}

describe("buildCorpusGraph — data-driven contract", () => {
  it("a manifest-only source (no registry entry) still becomes a node with the marketing default", () => {
    const g = buildCorpusGraph(manifest([rec({ id: "brand-new-source", title: "Brand New" })]));
    assert.equal(g.nodes.length, 1);
    assert.equal(g.nodes[0].id, "brand-new-source");
    assert.equal(g.nodes[0].pillar, "marketing");
    assert.ok(g.nodes[0].teaches.length > 0);
  });

  it("learn-only manifest records surface as tier 1S with synthesis provenance", () => {
    const g = buildCorpusGraph(
      manifest([rec({ id: "meta-blueprint", tier: "learn-only", license: "learn-only", mode: "synthesis-1s", chunks: 8 })]),
    );
    const n = g.nodes[0];
    assert.equal(n.tier, "1S");
    assert.deepEqual(n.synthesizedFrom, ["Meta Blueprint"]);
    assert.match(n.licenseBasis, /learn-only/);
  });

  it("pillar comes from the registry (design wave) without code changes", () => {
    const g = buildCorpusGraph(manifest([rec({ id: "apple-hig", tier: "learn-only", license: "learn-only", mode: "synthesis-1s" })]));
    assert.equal(g.nodes[0].pillar, "design");
  });

  it("shared-playbook sources link satellite → primary", () => {
    const g = buildCorpusGraph(
      manifest([
        rec({ id: "ibm-carbon", tier: "learn-only", license: "learn-only", mode: "synthesis-1s" }),
        rec({ id: "atlassian-design", tier: "learn-only", license: "learn-only", mode: "synthesis-1s", status: "pending", chunks: 0 }),
      ]),
    );
    const e = g.edges.find((x) => x.kind === "shared-playbook");
    assert.ok(e, "expected a shared-playbook edge");
    assert.equal(e!.from, "atlassian-design");
    assert.equal(e!.to, "ibm-carbon");
  });

  it("same-author verbatim sources link together", () => {
    const g = buildCorpusGraph(
      manifest([
        rec({ id: "scientific-advertising", author: "Claude Hopkins" }),
        rec({ id: "my-life-in-advertising", author: "Claude Hopkins" }),
        rec({ id: "unrelated", author: "Someone Else" }),
      ]),
    );
    const e = g.edges.find((x) => x.kind === "same-author");
    assert.ok(e);
    assert.deepEqual([e!.from, e!.to].sort(), ["my-life-in-advertising", "scientific-advertising"]);
  });

  it("proposed sources render as distinct proposed nodes", () => {
    const proposed: ProposedSource[] = [
      { id: "p1", title: "My New Source", pillar: "growth", kind: "url", url: "https://example.com", status: "proposed", createdAt: "2026-09-26", createdBy: "u1" },
    ];
    const g = buildCorpusGraph(manifest([rec({ id: "a" })]), proposed);
    const n = g.nodes.find((x) => x.id === "proposed:p1")!;
    assert.ok(n);
    assert.equal(n.kind, "proposed");
    assert.equal(n.pillar, "growth");
    assert.equal(g.stats.proposed, 1);
  });

  it("removal-flagged sources keep their data but report the flag", () => {
    const g = buildCorpusGraph(
      manifest([rec({ id: "a", chunks: 42 })]),
      [],
      new Map([["a", "outdated guidance"]]),
    );
    const n = g.nodes[0];
    assert.equal(n.kind, "removal-flagged");
    assert.equal(n.chunks, 42); // data is never silently dropped
    assert.equal(n.removalReason, "outdated guidance");
    assert.equal(g.stats.flagged, 1);
  });

  it("stats aggregate chunks and pillar counts", () => {
    const g = buildCorpusGraph(
      manifest([
        rec({ id: "apple-hig", tier: "learn-only", license: "learn-only", mode: "synthesis-1s", chunks: 14 }),
        rec({ id: "cxl-blog", tier: "learn-only", license: "learn-only", mode: "synthesis-1s", chunks: 6 }),
        rec({ id: "google-search-central", tier: 1, license: "CC-BY-4.0", chunks: 96 }),
      ]),
    );
    assert.equal(g.stats.chunks, 116);
    assert.equal(g.stats.pillars.design, 1);
    assert.equal(g.stats.pillars.growth, 1);
    assert.equal(g.stats.pillars.marketing, 1);
  });
});

describe("buildCorpusGraph — audit fields (real data only)", () => {
  it("attaches manifest provenance to every node", () => {
    const g = buildCorpusGraph(
      manifest([rec({ id: "apple-hig", tier: "learn-only", license: "learn-only", mode: "synthesis-1s" })]),
    );
    const n = g.nodes[0];
    assert.equal(n.manifestVersion, 7);
    assert.equal(n.retrievedDate, "2026-09-26");
  });

  it("proposed nodes have null provenance and zero counters", () => {
    const g = buildCorpusGraph(manifest([]), [
      { id: "p1", title: "Proposed", kind: "url", url: "https://x.com", pillar: "marketing" },
    ] as ProposedSource[]);
    const n = g.nodes.find((x) => x.id === "proposed:p1")!;
    assert.equal(n.manifestVersion, null);
    assert.equal(n.retrievedDate, null);
    assert.equal(n.evalHits, 0);
    assert.equal(n.retrievalHits, 0);
  });

  it("computes pillar chunk distribution and real eval/audit stats", () => {
    const g = buildCorpusGraph(
      manifest([
        rec({ id: "a", chunks: 100 }), // marketing (default), tier 2
        rec({ id: "b", chunks: 40 }), // marketing (default), tier 2
      ]),
      [],
      new Map(),
      {
        eval: { precision: 1, questions: 22, correct: 22, runAt: "2026-09-26T00:00:00Z" },
        evalHitsBySource: new Map([["a", 5]]),
        retrievalHitsBySource: new Map([["a", 3], ["b", 7]]),
      },
    );
    assert.equal(g.stats.pillarChunks.marketing, 140);
    assert.equal(g.stats.pillarChunks.growth, 0);
    assert.equal(g.stats.pillarChunks.design, 0);
    assert.equal(g.stats.eval!.correct, 22);
    assert.equal(g.stats.eval!.questions, 22);
    assert.equal(g.stats.retrievalHitsTotal, 10);
    assert.equal(g.nodes.find((n) => n.id === "a")!.evalHits, 5);
    assert.equal(g.nodes.find((n) => n.id === "b")!.retrievalHits, 7);
  });

  it("defaults to null eval and zero counters when no audit data is passed", () => {
    const g = buildCorpusGraph(manifest([rec({ id: "a", chunks: 10 })]));
    assert.equal(g.stats.eval, null);
    assert.equal(g.stats.retrievalHitsTotal, 0);
    assert.equal(g.nodes[0].evalHits, 0);
    assert.equal(g.nodes[0].retrievalHits, 0);
  });
});
