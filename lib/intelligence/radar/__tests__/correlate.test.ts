// Marketr — Phase 10 M2: correlation math tests.
// Run: npx tsx --test lib/intelligence/radar/__tests__/correlate.test.ts
//
// Synthetic GSC deltas (M1's PageQueryDelta contract):
//   - known-impacted pages (large deltas) MUST be flagged
//   - noise-only pages (small deltas) MUST NOT be flagged
//   - confidence bands must satisfy 0 <= lower <= upper <= 1
//   - direction must follow M1's sign convention (negative deltaPosition = up)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWindows,
  computeNoiseBand,
  flagImpacts,
  scoreWithBand,
} from "../correlate";
import type { PageQueryDelta } from "../types";

function delta(over: Partial<PageQueryDelta>): PageQueryDelta {
  return {
    projectId: "proj_1",
    page: "https://example.com/",
    query: "example query",
    deltaClicks: 0,
    deltaImpressions: 0,
    deltaPosition: 0,
    magnitude: 0,
    ...over,
  };
}

/** A site where 3 pages were genuinely hit by the update amid 40 noise pages. */
function syntheticSite(): PageQueryDelta[] {
  const deltas: PageQueryDelta[] = [];
  for (let i = 0; i < 40; i++) {
    deltas.push(
      delta({
        page: `https://example.com/noise-${i}`,
        query: `noise query ${i}`,
        deltaClicks: (i % 5) - 2, // −2..+2
        deltaImpressions: (i % 7) - 3,
        deltaPosition: (i % 3) - 1, // −1..+1
        magnitude: 2 + (i % 5), // 2..6
      }),
    );
  }
  deltas.push(
    delta({
      page: "https://example.com/hit-1",
      query: "money keyword",
      deltaClicks: -180,
      deltaImpressions: -900,
      deltaPosition: 6.2,
      magnitude: 68,
    }),
    delta({
      page: "https://example.com/hit-2",
      query: "brand keyword",
      deltaClicks: -95,
      deltaImpressions: -400,
      deltaPosition: 3.1,
      magnitude: 41,
    }),
    delta({
      page: "https://example.com/winner-1",
      query: "long tail",
      deltaClicks: 120,
      deltaImpressions: 700,
      deltaPosition: -2.4,
      magnitude: 52,
    }),
  );
  return deltas;
}

describe("noise band", () => {
  it("threshold sits above the noise cluster", () => {
    const band = computeNoiseBand(syntheticSite());
    assert.ok(band.threshold > 6, `threshold ${band.threshold} should exceed noise max 6`);
    assert.ok(band.threshold < 41, `threshold ${band.threshold} should flag the 41-magnitude page`);
  });

  it("empty delta set → threshold is finite and nothing flags", () => {
    const band = computeNoiseBand([]);
    assert.ok(Number.isFinite(band.threshold));
    const { impacts } = flagImpacts([]);
    assert.equal(impacts.length, 0);
  });
});

describe("flagImpacts", () => {
  it("known impacted pages are detected; noise-only pages are NOT flagged", () => {
    const { impacts } = flagImpacts(syntheticSite());
    const pages = impacts.map((i) => i.page);
    assert.ok(pages.includes("https://example.com/hit-1"), "hit-1 flagged");
    assert.ok(pages.includes("https://example.com/hit-2"), "hit-2 flagged");
    assert.ok(pages.includes("https://example.com/winner-1"), "winner-1 flagged");
    assert.equal(impacts.length, 3, `expected exactly 3 impacts, got ${impacts.length}`);
  });

  it("pure noise → zero impacts (no false claims)", () => {
    const noise = syntheticSite().filter((d) => d.page.includes("noise"));
    const { impacts } = flagImpacts(noise);
    assert.equal(impacts.length, 0);
  });

  it("confidence bands are honest: 0 <= lower <= upper <= 1, sorted desc", () => {
    const { impacts } = flagImpacts(syntheticSite());
    for (const i of impacts) {
      const [lo, hi] = i.confidenceBand;
      assert.ok(lo >= 0 && lo <= 1, `lower ${lo} in [0,1]`);
      assert.ok(hi >= 0 && hi <= 1, `upper ${hi} in [0,1]`);
      assert.ok(lo <= hi, `lower ${lo} <= upper ${hi}`);
      assert.ok(i.impactScore >= 0 && i.impactScore <= 1);
    }
    for (let k = 1; k < impacts.length; k++) {
      assert.ok(
        impacts[k - 1].impactScore >= impacts[k].impactScore,
        "impacts sorted by score desc",
      );
    }
  });

  it("direction follows M1's sign convention", () => {
    const { impacts } = flagImpacts(syntheticSite());
    const hit = impacts.find((i) => i.page.endsWith("hit-1"));
    const winner = impacts.find((i) => i.page.endsWith("winner-1"));
    assert.equal(hit?.direction, "declined"); // clicks down + position down (positive deltaPosition)
    assert.equal(winner?.direction, "improved"); // clicks up + position up (negative deltaPosition)
  });
});

describe("scoreWithBand", () => {
  it("higher z → higher score and tighter band", () => {
    const band: Parameters<typeof scoreWithBand>[1] = {
      median: 4,
      mad: 2,
      threshold: 8,
      deltasConsidered: 40,
    };
    const weak = scoreWithBand(10, band);
    const strong = scoreWithBand(60, band);
    assert.ok(strong.impactScore > weak.impactScore);
    const weakW = weak.confidenceBand[1] - weak.confidenceBand[0];
    const strongW = strong.confidenceBand[1] - strong.confidenceBand[0];
    assert.ok(strongW < weakW, "strong signal → tighter band");
  });
});

describe("buildWindows", () => {
  it("pre = 7d before start; post = start → end + 3d settle", () => {
    const w = buildWindows({
      startedAt: new Date("2026-08-18T16:27:00Z"),
      endedAt: new Date("2026-08-21T08:49:00Z"),
    });
    assert.ok(w);
    assert.equal(w.pre.start.toISOString(), "2026-08-11T16:27:00.000Z");
    assert.equal(w.pre.end.toISOString(), "2026-08-18T16:27:00.000Z");
    assert.equal(w.post.start.toISOString(), "2026-08-18T16:27:00.000Z");
    assert.equal(w.post.end.toISOString(), "2026-08-24T08:49:00.000Z");
  });

  it("event with no dates → null (correlate honestly or not at all)", () => {
    assert.equal(buildWindows({ startedAt: null, endedAt: null }), null);
  });

  it("open-ended rollout → post end = start + 3d settle", () => {
    const w = buildWindows({
      startedAt: new Date("2026-09-24T16:15:00Z"),
      endedAt: null,
    });
    assert.ok(w);
    assert.equal(w!.post.end.toISOString(), "2026-09-27T16:15:00.000Z");
  });
});
