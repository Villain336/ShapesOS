// Marketr — Phase 13D Worker B: pronunciation tests.
// Run: npx tsx --test lib/voice/__tests__/pronunciation.test.ts
//
// Pure part (no DB): applyPronunciation substitution contract —
//   - longest-term-first, case-insensitive, word-boundary matching
//   - applied snapshot records exactly the terms that fired
//
// Integration part (needs DATABASE_URL): seedFromKnowledgeGraph is
// idempotent — re-seeding inserts zero new rows (no duplicates), and
// manual entries survive.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { applyPronunciation, seedFromKnowledgeGraph, listEntries } from "../pronunciation";

const WS = "13d-pronunciation-battery";

describe("applyPronunciation", () => {
  it("substitutes longest-term-first with word boundaries", () => {
    const { script, applied } = applyPronunciation(
      "Marketr ProMax is better than ProMax. AI said said ai.",
      [
        { term: "ProMax", phonetic: "pro max" },
        { term: "Marketr ProMax", phonetic: "marketer pro max" },
        { term: "AI", phonetic: "ay eye" },
        { term: "Marketr", phonetic: "marketer" },
      ],
    );
    assert.equal(
      script,
      "marketer pro max is better than pro max. ay eye said said ay eye.",
    );
    // "AI" must never rewrite "said" — word boundaries hold.
    assert.ok(!script.includes("sayed"));
    const terms = applied.map((a) => a.term).sort();
    // Longest-first: "Marketr ProMax" fires as one unit, so the standalone
    // "Marketr" term has no remaining occurrence — it is correctly NOT recorded.
    assert.deepEqual(terms, ["AI", "Marketr ProMax", "ProMax"]);
  });

  it("matches case-insensitively and ignores empty entries", () => {
    const { script, applied } = applyPronunciation("shipready ships it", [
      { term: "ShipReady", phonetic: "ship ready" },
      { term: "  ", phonetic: "x" },
      { term: "y", phonetic: "   " },
    ]);
    assert.equal(script, "ship ready ships it");
    assert.deepEqual(applied, [{ term: "ShipReady", phonetic: "ship ready" }]);
  });

  it("returns an empty snapshot when nothing matches", () => {
    const { script, applied } = applyPronunciation("hello world", [
      { term: "Marketr", phonetic: "marketer" },
    ]);
    assert.equal(script, "hello world");
    assert.deepEqual(applied, []);
  });
});

describe("seedFromKnowledgeGraph (integration)", () => {
  before(async () => {
    await prisma.workspace.deleteMany({ where: { id: WS } });
    await prisma.workspace.create({
      data: { id: WS, name: "13d pronunciation battery", ownerUserId: "13d-owner" },
    });
    // 13B knowledge: a product with a brand-y name + a person-flavored title.
    // RLS on company_knowledge requires the workspace scope for writes.
    await withWorkspaceScope(WS, (tx) =>
      tx.companyKnowledge.createMany({
        data: [
          {
            workspaceId: WS,
            kind: "product",
            title: "Hullcheck Guardrail Engine",
            body: { name: "Hullcheck" },
          },
          {
            workspaceId: WS,
            kind: "pillar",
            title: "Tico Hamphill Method",
            body: {},
          },
          { workspaceId: WS, kind: "pricing", title: "Simple monthly pricing", body: {} },
        ],
      }),
    );
  });

  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: WS } });
  });

  it("seeds product/people terms and never duplicates on re-seed", async () => {
    const first = await seedFromKnowledgeGraph(WS);
    assert.ok(first.inserted > 0, `expected inserts, got ${JSON.stringify(first)}`);
    const seededTerms = (await listEntries(WS)).map((e) => e.term);
    assert.ok(seededTerms.includes("Hullcheck"), `missing Hullcheck: ${seededTerms}`);
    assert.ok(seededTerms.includes("Guardrail"), `missing Guardrail: ${seededTerms}`);
    assert.ok(seededTerms.includes("Tico"), `missing Tico: ${seededTerms}`);
    // Common words and non-target kinds must not seed.
    assert.ok(!seededTerms.includes("Simple"), "pricing-kind/common words must not seed");
    const sources = (await listEntries(WS)).map((e) => e.source);
    assert.ok(sources.every((s) => s === "knowledge_graph"));

    const second = await seedFromKnowledgeGraph(WS);
    assert.equal(second.inserted, 0, "re-seed must insert nothing");
    assert.equal(
      (await listEntries(WS)).length,
      seededTerms.length,
      "re-seed must not change row count",
    );

    // phonetic defaults to the term; human-editable after.
    const hull = (await listEntries(WS)).find((e) => e.term === "Hullcheck");
    assert.equal(hull?.phonetic, "Hullcheck");
  });
});
