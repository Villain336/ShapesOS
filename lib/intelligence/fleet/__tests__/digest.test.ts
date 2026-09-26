// Marketr — Phase 10 M4: weekly-digest aggregation math tests.
// Run: npx tsx --test lib/intelligence/fleet/__tests__/digest.test.ts
//
// aggregateDigest is the pure aggregation core of buildWeeklyDigest — tested
// on fixtures with no DB or network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateDigest, type DigestInput } from "../digest";

function fixtureInput(): DigestInput {
  const weekStart = new Date("2026-09-19T00:00:00Z");
  const weekEnd = new Date("2026-09-26T00:00:00Z");
  const at = (day: number) => new Date(`2026-09-${String(day).padStart(2, "0")}T12:00:00Z`);
  return {
    workspaceId: "ws_1",
    weekStart,
    weekEnd,
    watches: [
      { id: "w_acme", competitorDomain: "acme.example", projectId: "p1" },
      { id: "w_globex", competitorDomain: "globex.example", projectId: "p1" },
      { id: "w_quiet", competitorDomain: "quiet.example", projectId: "p1" },
    ],
    keywords: ["crm software", "pipeline tool"],
    pageChangeByWatch: new Set(["w_acme"]),
    changes: [
      { watchId: "w_acme", competitorDomain: "acme.example", url: "https://acme.example/new-1", changeType: "page_added", semanticSummary: "New pricing page", detectedAt: at(20) },
      { watchId: "w_acme", competitorDomain: "acme.example", url: "https://acme.example/new-2", changeType: "page_added", semanticSummary: "New integration page", detectedAt: at(21) },
      { watchId: "w_acme", competitorDomain: "acme.example", url: "https://acme.example/pricing", changeType: "content_updated", semanticSummary: "Pricing changed: plans now $29/mo", detectedAt: at(22) },
      { watchId: "w_acme", competitorDomain: "acme.example", url: "https://acme.example/old", changeType: "page_removed", semanticSummary: null, detectedAt: at(23) },
      { watchId: "w_globex", competitorDomain: "globex.example", url: "https://globex.example/blog/post", changeType: "page_added", semanticSummary: "New blog post about discounts", detectedAt: at(24) },
      { watchId: "w_globex", competitorDomain: "globex.example", url: "https://globex.example/x", changeType: "content_updated", semanticSummary: "Updated homepage copy", detectedAt: at(25) },
      // unknown watch → skipped
      { watchId: "w_gone", competitorDomain: "gone.example", url: "https://gone.example/y", changeType: "page_added", semanticSummary: null, detectedAt: at(25) },
    ],
  };
}

describe("aggregateDigest", () => {
  it("counts adds/removes/updates per competitor and totals", () => {
    const d = aggregateDigest(fixtureInput());
    assert.equal(d.workspaceId, "ws_1");
    assert.equal(d.weekStart, "2026-09-19T00:00:00.000Z");
    assert.equal(d.weekEnd, "2026-09-26T00:00:00.000Z");

    const acme = d.competitors.find((c) => c.domain === "acme.example")!;
    assert.equal(acme.pagesAdded, 2);
    assert.equal(acme.pagesRemoved, 1);
    assert.equal(acme.pagesUpdated, 1); // content_updated bucket

    const globex = d.competitors.find((c) => c.domain === "globex.example")!;
    assert.equal(globex.pagesAdded, 1);
    assert.equal(globex.pagesUpdated, 1);

    assert.deepEqual(d.totals, {
      pagesAdded: 3,
      pagesRemoved: 1,
      pagesUpdated: 2,
      pricingOfferChanges: 3, // "$29/mo" + "pricing page" + "discounts"
      changes: 6, // unknown-watch row excluded
    });
  });

  it("detects pricing/offer language in summaries AND urls", () => {
    const d = aggregateDigest(fixtureInput());
    const acme = d.competitors.find((c) => c.domain === "acme.example")!;
    // new-1 ("New pricing page"), pricing url + "$29/mo" summary
    assert.equal(acme.pricingOfferChanges, 2);
  });

  it("caps topChanges at 5 and sorts newest-first", () => {
    const input = fixtureInput();
    for (let i = 0; i < 8; i++) {
      input.changes.push({
        watchId: "w_acme",
        competitorDomain: "acme.example",
        url: `https://acme.example/extra-${i}`,
        changeType: "page_added",
        semanticSummary: null,
        detectedAt: new Date(`2026-09-${String(10 + i).padStart(2, "0")}T12:00:00Z`),
      });
    }
    const d = aggregateDigest(input);
    const acme = d.competitors.find((c) => c.domain === "acme.example")!;
    assert.equal(acme.topChanges.length, 5);
    // newest first: 2026-09-23 removal, then 2026-09-22 pricing change
    assert.equal(acme.topChanges[0].url, "https://acme.example/old");
    assert.equal(acme.topChanges[1].url, "https://acme.example/pricing");
  });

  it("drops competitors with zero changes from the digest", () => {
    const d = aggregateDigest(fixtureInput());
    assert.ok(!d.competitors.some((c) => c.domain === "quiet.example"));
  });

  it("empty input → zeroed digest, no crash", () => {
    const d = aggregateDigest({
      workspaceId: "ws_empty",
      weekStart: new Date("2026-09-19T00:00:00Z"),
      weekEnd: new Date("2026-09-26T00:00:00Z"),
      changes: [],
      watches: [{ id: "w1", competitorDomain: "x.example", projectId: "p1" }],
      keywords: [],
      pageChangeByWatch: new Set(),
    });
    assert.deepEqual(d.totals, {
      pagesAdded: 0,
      pagesRemoved: 0,
      pagesUpdated: 0,
      pricingOfferChanges: 0,
      changes: 0,
    });
    assert.deepEqual(d.competitors, []);
  });
});
