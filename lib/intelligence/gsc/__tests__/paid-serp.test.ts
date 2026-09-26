// Marketr — Phase 10 M1 tests: paid SERP is residual-only.
// Run: npx tsx --test lib/intelligence/gsc/__tests__/paid-serp.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCheckSource,
  resolveRankChecks,
  paidCallCount,
  type RankCheckKeyword,
} from "../paid-serp";
import type { SerpResponse } from "@/lib/intelligence/providers";

function owned(phrase: string, gscPosition: number | null = 3): RankCheckKeyword {
  return {
    phrase,
    locale: "en-US",
    isCompetitorKeyword: false,
    zeroImpressions: false,
    needSerpFeatures: false,
    gscPosition,
  };
}

function fakeSerp(keyword: string): SerpResponse {
  return {
    keyword,
    locale: "en-US",
    results: [{ position: 4, title: "t", url: "https://example.com/x", domain: "example.com" }],
    aiOverviewPresent: false,
    serpFeatures: [],
    fetchedAt: new Date("2026-09-26T00:00:00Z"),
    vendor: "serper",
    costUsd: 0,
  };
}

describe("classifyCheckSource", () => {
  it("owned keywords resolve from GSC", () => {
    assert.equal(classifyCheckSource(owned("dentist greenville")), "gsc");
  });

  it("competitor keywords go to the paid vendor", () => {
    assert.equal(classifyCheckSource({ ...owned("rival keyword"), isCompetitorKeyword: true }), "paid_vendor");
  });

  it("zero-impression queries go to the paid vendor", () => {
    assert.equal(classifyCheckSource({ ...owned("no data query"), zeroImpressions: true }), "paid_vendor");
  });

  it("SERP-feature composition goes to the paid vendor", () => {
    assert.equal(classifyCheckSource({ ...owned("feature query"), needSerpFeatures: true }), "paid_vendor");
  });
});

describe("resolveRankChecks", () => {
  it("owned-keyword rank checks NEVER call fetchSerp", async () => {
    let calls = 0;
    const rows = await resolveRankChecks(
      "ws1",
      [owned("dentist greenville"), owned("teeth whitening"), owned("emergency dentist", null)],
      {
        fetchSerpImpl: async (...args) => {
          calls++;
          return fakeSerp(args[1]);
        },
      },
    );
    assert.equal(calls, 0, "fetchSerp must not be called for owned keywords");
    assert.equal(paidCallCount(rows), 0);
    assert.ok(rows.every((r) => r.source === "gsc"));
    assert.equal(rows[0].postPosition, 3);
  });

  it("residual keywords call fetchSerp once each and are badged paid", async () => {
    let calls = 0;
    const rows = await resolveRankChecks(
      "ws1",
      [
        owned("dentist greenville"),
        { ...owned("rival keyword"), isCompetitorKeyword: true },
        { ...owned("zero imp query"), zeroImpressions: true },
        { ...owned("aio query"), needSerpFeatures: true },
      ],
      {
        fetchSerpImpl: async (workspaceId, keyword, locale, opts) => {
          calls++;
          assert.equal(workspaceId, "ws1");
          assert.equal(locale, "en-US");
          return fakeSerp(keyword);
        },
      },
    );
    assert.equal(calls, 3, "exactly the 3 residual keywords hit the vendor");
    assert.equal(paidCallCount(rows), 3);
    assert.deepEqual(
      rows.map((r) => r.source),
      ["gsc", "paid", "paid", "paid"],
    );
  });

  it("passes needAiOverview through only when SERP features are needed", async () => {
    const seen: Array<{ keyword: string; needAiOverview?: boolean }> = [];
    await resolveRankChecks(
      "ws1",
      [
        { ...owned("plain rival"), isCompetitorKeyword: true },
        { ...owned("aio rival"), isCompetitorKeyword: true, needSerpFeatures: true },
      ],
      {
        fetchSerpImpl: async (_w, keyword, _l, opts) => {
          seen.push({ keyword, needAiOverview: opts?.needAiOverview });
          return fakeSerp(keyword);
        },
      },
    );
    assert.deepEqual(
      seen.map((s) => s.needAiOverview ?? false),
      [false, true],
    );
  });
});
