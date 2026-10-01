// Marketr — Wave 2 Insurance slice 2 tests: quoting domain, CoverForce
// adapter, thin MCP shim.
// Run: npx tsx --test lib/insurance/__tests__/quoting.test.ts
//
// No database, no network. Proves: the quote machine, fail-closed intake,
// honest normalization (declines kept, no invented metrics), the fixture
// adapter's fail-closed gates, and the shim's workspace/honesty contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertQuoteTransition,
  deriveSubmissionStatus,
  isValidQuoteTransition,
  normalizeQuotes,
  validateSubmissionIntake,
  type RawVendorQuote,
} from "../quoting";
import { InsuranceError } from "../types";
import { CoverForceVendor } from "../coverforce";
import { InsuranceVendorError } from "../mock-vendor";
import { getShimTool, INSURANCE_SHIM_TOOLS, ShimToolError } from "../mcp-shim";

describe("quote status machine", () => {
  it("draft → quoted | declined | referred", () => {
    assert.equal(isValidQuoteTransition("draft", "quoted"), true);
    assert.equal(isValidQuoteTransition("draft", "declined"), true);
    assert.equal(isValidQuoteTransition("draft", "referred"), true);
  });
  it("quoted → bound | expired (bind path opens in slice 3)", () => {
    assert.equal(isValidQuoteTransition("quoted", "bound"), true);
    assert.equal(isValidQuoteTransition("quoted", "expired"), true);
    assert.equal(isValidQuoteTransition("quoted", "declined"), false);
  });
  it("declined / referred / expired / bound are terminal", () => {
    for (const s of ["declined", "referred", "expired", "bound"] as const) {
      assert.equal(isValidQuoteTransition(s, "quoted"), false);
    }
  });
  it("assert throws a named error", () => {
    assert.throws(
      () => assertQuoteTransition("bound", "quoted"),
      (e: unknown) => e instanceof InsuranceError && e.code === "INVALID_QUOTE_TRANSITION",
    );
  });
});

describe("submission intake validation (fail closed)", () => {
  const good = {
    line: "gl" as const,
    applicantName: "Acme Landscaping LLC",
    state: "NC",
    payrollCents: 1_200_000_00,
    lossHistory: [{ year: 2024, claimCount: 1, totalCents: 45_000_00 }],
  };
  it("accepts a complete intake", () => {
    validateSubmissionIntake(good);
  });
  it("rejects a blank applicant name (submitting discloses business data)", () => {
    assert.throws(
      () => validateSubmissionIntake({ ...good, applicantName: " " }),
      (e: unknown) => e instanceof InsuranceError && e.code === "APPLICANT_REQUIRED",
    );
  });
  it("rejects a non-2-letter state", () => {
    assert.throws(
      () => validateSubmissionIntake({ ...good, state: "North Carolina" }),
      (e: unknown) => e instanceof InsuranceError && e.code === "BAD_STATE",
    );
  });
  it("rejects negative money", () => {
    assert.throws(
      () => validateSubmissionIntake({ ...good, revenueCents: -1 }),
      (e: unknown) => e instanceof InsuranceError && e.code === "BAD_MONEY_VALUE",
    );
  });
  it("rejects a future loss-history year", () => {
    assert.throws(
      () =>
        validateSubmissionIntake({
          ...good,
          lossHistory: [{ year: 2099, claimCount: 0, totalCents: 0 }],
        }),
      (e: unknown) => e instanceof InsuranceError && e.code === "BAD_LOSS_YEAR",
    );
  });
});

const VENDOR_QUOTES: RawVendorQuote[] = [
  {
    carrierName: "Chubb",
    quotedPremiumCents: 512_000,
    limitPerOccurrenceCents: 100_000_000,
    limitAggregateCents: 200_000_000,
    quoteExpiry: "2026-11-01T00:00:00.000Z",
    status: "quoted",
  },
  {
    carrierName: "Travelers",
    quotedPremiumCents: 468_000,
    limitPerOccurrenceCents: 100_000_000,
    limitAggregateCents: 200_000_000,
    quoteExpiry: "2026-11-01T00:00:00.000Z",
    status: "quoted",
  },
  {
    carrierName: "AmTrust",
    quotedPremiumCents: null,
    limitPerOccurrenceCents: null,
    limitAggregateCents: null,
    quoteExpiry: "2026-11-01T00:00:00.000Z",
    status: "declined",
    declineReason: "Class code outside current appetite.",
  },
];

describe("quote normalization", () => {
  it("ranks quoted offers cheapest-first and computes per-$1M-aggregate", () => {
    const n = normalizeQuotes(VENDOR_QUOTES);
    const travelers = n.find((q) => q.carrierName === "Travelers")!;
    const chubb = n.find((q) => q.carrierName === "Chubb")!;
    assert.equal(travelers.rank, 1);
    assert.equal(chubb.rank, 2);
    // 468000 / 200000000 * 100000000 = 234000 cents per $1M aggregate
    assert.equal(travelers.premiumPerMillionAggregateCents, 234_000);
  });
  it("keeps declines in the comparison with their reasons, unranked", () => {
    const n = normalizeQuotes(VENDOR_QUOTES);
    const declined = n.find((q) => q.carrierName === "AmTrust")!;
    assert.equal(declined.status, "declined");
    assert.equal(declined.rank, null);
    assert.equal(declined.premiumPerMillionAggregateCents, null);
    assert.ok(declined.declineReason);
  });
  it("never invents the metric when limits are missing", () => {
    const n = normalizeQuotes([
      {
        carrierName: "Solo",
        quotedPremiumCents: 100_000,
        limitPerOccurrenceCents: null,
        limitAggregateCents: null,
        quoteExpiry: "2026-11-01T00:00:00.000Z",
        status: "quoted",
      },
    ]);
    assert.equal(n[0]!.premiumPerMillionAggregateCents, null);
    assert.equal(n[0]!.rank, 1);
  });
});

describe("deriveSubmissionStatus", () => {
  it("quoted wins when any quote is quoted", () => {
    assert.equal(deriveSubmissionStatus(["declined", "quoted"]), "quoted");
  });
  it("all-declined → declined", () => {
    assert.equal(deriveSubmissionStatus(["declined", "declined"]), "declined");
  });
  it("empty → submitted", () => {
    assert.equal(deriveSubmissionStatus([]), "submitted");
  });
});

describe("CoverForce adapter gates", () => {
  it("fixture mode works and is labeled not-live", async () => {
    const v = new CoverForceVendor({ mode: "fixture" });
    assert.equal(v.isLive, false);
    assert.equal(v.name, "coverforce");
    const appetite = await v.checkAppetite({ line: "gl", state: "NC" });
    assert.ok(appetite.notes.startsWith("[fixture]"));
  });
  it("live mode without credentials fails closed", () => {
    assert.throws(
      () => new CoverForceVendor({ mode: "live" }),
      (e: unknown) => e instanceof InsuranceVendorError && e.code === "VENDOR_NOT_CONFIGURED",
    );
  });
  it("bind fails closed with PARTNER_NOT_APPOINTED without an appointed partner", async () => {
    const v = new CoverForceVendor({ mode: "fixture" });
    await assert.rejects(
      () => v.bind({ quoteRef: "Q-1", partnerId: "  " }),
      (e: unknown) =>
        e instanceof InsuranceVendorError && e.code === "PARTNER_NOT_APPOINTED",
    );
  });
  it("bind with an appointed partner executes in fixture mode", async () => {
    const v = new CoverForceVendor({ mode: "fixture" });
    const result = await v.bind({ quoteRef: "Q-1", partnerId: "partner-1" });
    assert.ok(result.policyNumber.startsWith("MOCK-POL-"));
  });
});

describe("thin MCP shim", () => {
  const ctx = { workspaceId: "ws-1", actor: "user-1" };
  it("exposes exactly three tools", () => {
    assert.deepEqual(
      INSURANCE_SHIM_TOOLS.map((t) => t.name).sort(),
      ["insurance_check_appetite", "insurance_get_quotes", "insurance_submit_risk"],
    );
  });
  it("throws a named error for unknown tools", () => {
    assert.throws(
      () => getShimTool("insurance_nuke"),
      (e: unknown) => e instanceof ShimToolError && e.code === "UNKNOWN_TOOL",
    );
  });
  it("labels fixture responses live:false", async () => {
    const tool = getShimTool("insurance_check_appetite");
    const result = await tool.handler(ctx, { line: "gl", state: "NC" });
    assert.equal(result.data.live, false);
    assert.ok(Array.isArray(result.data.carriers));
  });
  it("rejects invalid args with zod (bad state code)", async () => {
    const tool = getShimTool("insurance_submit_risk");
    await assert.rejects(() =>
      tool.handler(ctx, { line: "gl", applicantName: "Acme", state: "XXL" }),
    );
  });
  it("submit requires an applicant name", async () => {
    const tool = getShimTool("insurance_submit_risk");
    await assert.rejects(() =>
      tool.handler(ctx, { line: "gl", applicantName: "  ", state: "NC" }),
    );
  });
});
