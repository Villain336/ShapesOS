// Phase 18 slice 6: unified reporting rollups — pure-function tests (no DB).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultRange,
  emptyTotals,
  parseRangeDate,
  rollupByCampaign,
  rollupByPlatform,
  rollupRows,
  type AdReportRowLike,
} from "../unified-reporting";

function row(over: Partial<AdReportRowLike>): AdReportRowLike {
  return {
    platformKey: "amazon",
    platformLabel: "Amazon Ads",
    campaignId: "c1",
    campaignName: "Camp 1",
    date: new Date("2026-09-01T00:00:00Z"),
    spendCents: 1000,
    impressions: 10000,
    clicks: 200,
    ctr: null,
    conversions: 10,
    revenueCents: 5000,
    approvalId: "ap1",
    platformReceiptId: "rc1",
    ...over,
  };
}

describe("rollupRows", () => {
  it("sums metrics and derives CTR and ROAS", () => {
    const t = rollupRows([row({}), row({ spendCents: 3000, clicks: 100, revenueCents: 9000 })]);
    assert.equal(t.spendCents, 4000);
    assert.equal(t.impressions, 20000);
    assert.equal(t.clicks, 300);
    assert.equal(t.conversions, 20);
    assert.equal(t.revenueCents, 14000);
    assert.ok(Math.abs((t.ctr ?? -1) - 0.015) < 1e-9);
    assert.ok(Math.abs((t.roas ?? -1) - 3.5) < 1e-9);
    assert.equal(t.rowCount, 2);
  });

  it("never divides by zero: ROAS is null on zero spend", () => {
    const t = rollupRows([row({ spendCents: 0, revenueCents: 500 })]);
    assert.equal(t.roas, null);
    assert.notEqual(t.roas, Infinity);
    assert.ok(!(t.roas !== null && Number.isNaN(t.roas)));
  });

  it("CTR is null when there are no impressions", () => {
    const t = rollupRows([row({ impressions: 0, clicks: 0 })]);
    assert.equal(t.ctr, null);
  });

  it("empty input yields zeroed totals with null derived metrics", () => {
    const t = rollupRows([]);
    assert.deepEqual(t, emptyTotals());
  });
});

describe("rollupByPlatform", () => {
  it("groups by platform and orders by spend desc", () => {
    const rows = [
      row({ platformKey: "amazon", platformLabel: "Amazon Ads", spendCents: 1000 }),
      row({ platformKey: "stackadapt", platformLabel: "StackAdapt", spendCents: 4000, campaignId: "c2", campaignName: "Camp 2" }),
      row({ platformKey: "amazon", platformLabel: "Amazon Ads", spendCents: 500, campaignId: "c3", campaignName: "Camp 3" }),
    ];
    const out = rollupByPlatform(rows);
    assert.equal(out.length, 2);
    assert.equal(out[0].platformKey, "stackadapt");
    assert.equal(out[0].totals.spendCents, 4000);
    assert.equal(out[1].platformKey, "amazon");
    assert.equal(out[1].totals.spendCents, 1500);
    assert.ok(Math.abs((out[1].totals.roas ?? -1) - 10000 / 1500) < 1e-9);
  });

  it("zero-spend platform gets null ROAS, not NaN", () => {
    const out = rollupByPlatform([row({ spendCents: 0 })]);
    assert.equal(out[0].totals.roas, null);
  });
});

describe("rollupByCampaign", () => {
  it("groups by campaign keeping platform labels, ordered by spend desc", () => {
    const rows = [
      row({ campaignId: "c1", campaignName: "Camp 1", spendCents: 1000 }),
      row({ campaignId: "c2", campaignName: "Camp 2", spendCents: 2500, revenueCents: 7500 }),
    ];
    const out = rollupByCampaign(rows);
    assert.equal(out.length, 2);
    assert.equal(out[0].campaignId, "c2");
    assert.equal(out[0].platformLabel, "Amazon Ads");
    assert.ok(Math.abs((out[0].totals.roas ?? -1) - 3) < 1e-9);
  });
});

describe("parseRangeDate", () => {
  it("accepts YYYY-MM-DD and rejects garbage", () => {
    const d = parseRangeDate("2026-09-15");
    assert.ok(d instanceof Date && d.toISOString().slice(0, 10) === "2026-09-15");
    assert.equal(parseRangeDate("nope"), null);
    assert.equal(parseRangeDate(undefined), null);
    assert.equal(parseRangeDate("2026-13-40"), null);
  });
});

describe("defaultRange", () => {
  it("covers 30 days inclusive ending today", () => {
    const { from, to } = defaultRange(new Date("2026-09-30T12:00:00Z"));
    assert.equal(to.toISOString().slice(0, 10), "2026-09-30");
    assert.equal(from.toISOString().slice(0, 10), "2026-09-01");
  });
});
