// Phase 18 slice 6: report-engine ads figures — grounded-figure tests (no DB).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateFigures } from "../../reports/figures";
import { buildAdReportFigures } from "../report-figures";
import type { AdReportRowLike } from "../unified-reporting";

function row(over: Partial<AdReportRowLike>): AdReportRowLike {
  return {
    platformKey: "amazon",
    platformLabel: "Amazon Ads",
    campaignId: "c1",
    campaignName: "Camp 1",
    date: new Date("2026-09-01T00:00:00Z"),
    spendCents: 10000,
    impressions: 50000,
    clicks: 1000,
    ctr: null,
    conversions: 40,
    revenueCents: 30000,
    approvalId: "ap1",
    platformReceiptId: "rc1",
    ...over,
  };
}

const base = {
  workspaceId: "ws1",
  from: new Date("2026-09-01T00:00:00Z"),
  to: new Date("2026-09-30T00:00:00Z"),
  periodLabel: "September 2026",
};

describe("buildAdReportFigures", () => {
  it("builds six grounded figures from rows", () => {
    const rows = [
      row({}),
      row({ campaignId: "c2", campaignName: "Camp 2", spendCents: 5000, revenueCents: 20000, approvalId: "ap2", platformReceiptId: "rc2" }),
    ];
    const figs = buildAdReportFigures({ ...base, rows });
    assert.equal(figs.length, 6);
    const byKey = new Map(figs.map((f) => [f.key, f]));
    assert.equal(byKey.get("ads_total_spend")?.value, "$150.00");
    assert.equal(byKey.get("ads_total_revenue")?.value, "$500.00");
    assert.equal(byKey.get("ads_blended_roas")?.value, "3.33×");
    assert.match(byKey.get("ads_spend_by_platform")?.value ?? "", /Amazon Ads \$150\.00/);
    assert.match(byKey.get("ads_top_campaigns")?.value ?? "", /Camp 1/);
    assert.match(byKey.get("ads_approval_lineage")?.value ?? "", /2 approvals · 2 platform receipts/);
    // The iron guardrail: every figure grounded, all values strings.
    const evalResult = evaluateFigures(figs);
    assert.equal(evalResult.allGrounded, true);
    assert.deepEqual(evalResult.ungroundedKeys, []);
    for (const f of figs) assert.equal(typeof f.value, "string");
  });

  it("renders honestly with no rows: single grounded note", () => {
    const figs = buildAdReportFigures({ ...base, rows: [] });
    assert.equal(figs.length, 1);
    assert.equal(figs[0].key, "ads_no_data");
    assert.equal(figs[0].value, "No ad spend in period");
    assert.equal(evaluateFigures(figs).allGrounded, true);
  });

  it("zero-spend rows give a null-ROAS figure, never NaN", () => {
    const figs = buildAdReportFigures({ ...base, rows: [row({ spendCents: 0, revenueCents: 0 })] });
    const roas = figs.find((f) => f.key === "ads_blended_roas");
    assert.ok(roas);
    assert.ok(!/NaN|Infinity/.test(roas.value));
    assert.equal(evaluateFigures(figs).allGrounded, true);
  });

  it("imported rows without approvals still ground the lineage note", () => {
    const figs = buildAdReportFigures({
      ...base,
      rows: [row({ approvalId: null, platformReceiptId: "import:batch1" })],
    });
    const lineage = figs.find((f) => f.key === "ads_approval_lineage");
    assert.ok(lineage);
    assert.match(lineage.value, /0 approvals · 1 platform receipt/);
    assert.equal(evaluateFigures(figs).allGrounded, true);
  });
});
