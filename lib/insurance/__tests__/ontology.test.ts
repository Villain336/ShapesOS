// Marketr — Wave 2 Insurance slice 1 tests: ontology, validation, renewal
// alerts, declarations parsing, mock vendor contract.
// Run: npx tsx --test lib/insurance/__tests__/ontology.test.ts
//
// Stub-free pure domain tests plus the mock vendor. No database, no network.
// Proves the fail-closed rules: no invented coverage, no bind without a
// resolved license model, renewals surfaced never silently accepted.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertPolicyStatusTransition,
  assertRemarketTransition,
  daysUntilRenewal,
  declarationsNeedReview,
  DECLARATIONS_REVIEW_THRESHOLD,
  DEFAULT_DELTA_FLAG_THRESHOLD_PCT,
  deltaExceedsThreshold,
  InsuranceError,
  isValidPolicyStatusTransition,
  isValidRemarketTransition,
  parseDeclarationsText,
  premiumDeltaPct,
  renewalAlertLevel,
  validatePolicyInput,
} from "../types";
import {
  InsuranceVendorError,
  MOCK_CARRIERS,
  MOCK_POLICIES,
  MockCoverForceVendor,
} from "../mock-vendor";

describe("policy status machine", () => {
  it("allows active → pending_renewal → active (renewed)", () => {
    assert.equal(isValidPolicyStatusTransition("active", "pending_renewal"), true);
    assert.equal(isValidPolicyStatusTransition("pending_renewal", "active"), true);
  });
  it("allows terminal moves to expired and cancelled, then nothing", () => {
    assert.equal(isValidPolicyStatusTransition("active", "expired"), true);
    assert.equal(isValidPolicyStatusTransition("pending_renewal", "cancelled"), true);
    assert.equal(isValidPolicyStatusTransition("expired", "active"), false);
    assert.equal(isValidPolicyStatusTransition("cancelled", "pending_renewal"), false);
  });
  it("assert throws a named error on illegal transitions", () => {
    assert.throws(
      () => assertPolicyStatusTransition("expired", "active"),
      (e: unknown) =>
        e instanceof InsuranceError && e.code === "INVALID_STATUS_TRANSITION",
    );
  });
});

describe("renewal remarket machine", () => {
  it("detected → remarketing → quoted → bound", () => {
    assert.equal(isValidRemarketTransition("detected", "remarketing"), true);
    assert.equal(isValidRemarketTransition("remarketing", "quoted"), true);
    assert.equal(isValidRemarketTransition("quoted", "bound"), true);
  });
  it("detected → auto_renew_surfaced is the surfaced-not-silent path", () => {
    assert.equal(isValidRemarketTransition("detected", "auto_renew_surfaced"), true);
    // Never auto-bind straight through: detected may not jump to bound.
    assert.equal(isValidRemarketTransition("detected", "bound"), false);
  });
  it("bound and auto_renew_surfaced are terminal", () => {
    assert.equal(isValidRemarketTransition("bound", "quoted"), false);
    assert.equal(isValidRemarketTransition("auto_renew_surfaced", "bound"), false);
  });
  it("assert throws a named error on illegal transitions", () => {
    assert.throws(
      () => assertRemarketTransition("detected", "bound"),
      (e: unknown) =>
        e instanceof InsuranceError && e.code === "INVALID_REMARKET_TRANSITION",
    );
  });
});

describe("policy validation (fail closed)", () => {
  const good = {
    policyNumber: "GL-2026-004812",
    carrierId: "carrier-1",
    line: "gl" as const,
    namedInsured: "Acme Landscaping LLC",
    effectiveAt: new Date("2026-01-15T00:00:00Z"),
    expiresAt: new Date("2027-01-15T00:00:00Z"),
  };
  it("accepts a complete policy without limits (limits may be 'not confirmed')", () => {
    validatePolicyInput(good);
  });
  it("rejects missing policy number", () => {
    assert.throws(
      () => validatePolicyInput({ ...good, policyNumber: "  " }),
      (e: unknown) => e instanceof InsuranceError && e.code === "POLICY_NUMBER_REQUIRED",
    );
  });
  it("rejects missing carrier", () => {
    assert.throws(
      () => validatePolicyInput({ ...good, carrierId: "" }),
      (e: unknown) => e instanceof InsuranceError && e.code === "CARRIER_REQUIRED",
    );
  });
  it("rejects an inverted term window", () => {
    assert.throws(
      () =>
        validatePolicyInput({
          ...good,
          effectiveAt: new Date("2027-01-15T00:00:00Z"),
          expiresAt: new Date("2026-01-15T00:00:00Z"),
        }),
      (e: unknown) => e instanceof InsuranceError && e.code === "INVERTED_TERM",
    );
  });
  it("rejects negative money values", () => {
    assert.throws(
      () => validatePolicyInput({ ...good, annualPremiumCents: -100 }),
      (e: unknown) => e instanceof InsuranceError && e.code === "BAD_MONEY_VALUE",
    );
  });
});

describe("renewal alerts", () => {
  const now = new Date("2026-10-01T00:00:00Z");
  const inDays = (d: number) => new Date(now.getTime() + d * 86400_000);
  it("critical at ≤30 days, warning ≤60, info ≤90, none beyond", () => {
    assert.equal(renewalAlertLevel(inDays(20), now), "critical");
    assert.equal(renewalAlertLevel(inDays(45), now), "warning");
    assert.equal(renewalAlertLevel(inDays(75), now), "info");
    assert.equal(renewalAlertLevel(inDays(200), now), "none");
  });
  it("expired policies are critical", () => {
    assert.equal(renewalAlertLevel(inDays(-5), now), "critical");
  });
  it("daysUntilRenewal floors whole days", () => {
    assert.equal(daysUntilRenewal(inDays(45), now), 45);
  });
});

describe("premium delta flags", () => {
  it("computes (new - prior) / prior * 100", () => {
    assert.equal(premiumDeltaPct(100_000, 115_000), 15);
    assert.equal(premiumDeltaPct(100_000, 90_000), -10);
  });
  it("flags deltas above the default 10% threshold", () => {
    assert.equal(deltaExceedsThreshold(100_000, 115_000), true);
    assert.equal(deltaExceedsThreshold(100_000, 105_000), false);
    assert.equal(
      deltaExceedsThreshold(100_000, 85_000),
      true,
      "a 15% decrease flags too",
    );
    assert.equal(DEFAULT_DELTA_FLAG_THRESHOLD_PCT, 10);
  });
  it("refuses a non-positive prior premium", () => {
    assert.throws(
      () => premiumDeltaPct(0, 100_000),
      (e: unknown) => e instanceof InsuranceError && e.code === "BAD_PRIOR_PREMIUM",
    );
  });
});

const GL_DECLARATIONS = `
COMMERCIAL GENERAL LIABILITY DECLARATIONS
Carrier: Chubb
Policy Number: GL-2026-004812
Named Insured: Acme Landscaping LLC
Policy Period: Effective January 15, 2026  Expiration January 15, 2027
LIMITS OF INSURANCE
Each Occurrence Limit: $1,000,000
General Aggregate Limit: $2,000,000
Deductible: $1,000
Annual Premium: $4,850.00
`;

const WC_DECLARATIONS = `
WORKERS COMPENSATION DECLARATIONS
Carrier: AmTrust
Policy No. WC-2025-118833
Named Insured - Acme Landscaping LLC
Effective November 1, 2025
Expiration November 1, 2026
Annual Premium: $9,120.00
`;

describe("declarations-page parsing", () => {
  it("extracts a full GL declarations page", () => {
    const p = parseDeclarationsText(GL_DECLARATIONS);
    assert.equal(p.policyNumber, "GL-2026-004812");
    assert.equal(p.carrierName, "Chubb");
    assert.equal(p.namedInsured, "Acme Landscaping LLC");
    assert.equal(p.line, "gl");
    assert.equal(p.effectiveAt?.toISOString(), "2026-01-15T00:00:00.000Z");
    assert.equal(p.expiresAt?.toISOString(), "2027-01-15T00:00:00.000Z");
    assert.equal(p.limitPerOccurrenceCents, 100_000_000);
    assert.equal(p.limitAggregateCents, 200_000_000);
    assert.equal(p.deductibleCents, 100_000);
    assert.equal(p.annualPremiumCents, 485_000);
    assert.equal(p.confidence, 1);
    assert.equal(declarationsNeedReview(p), false);
  });
  it("leaves missing limits null instead of inventing them (WC has no limits)", () => {
    const p = parseDeclarationsText(WC_DECLARATIONS);
    assert.equal(p.policyNumber, "WC-2025-118833");
    assert.equal(p.line, "wc");
    assert.equal(p.limitPerOccurrenceCents, null);
    assert.equal(p.limitAggregateCents, null);
    assert.equal(p.annualPremiumCents, 912_000);
    assert.equal(declarationsNeedReview(p), false);
  });
  it("routes low-confidence parses to human review", () => {
    const p = parseDeclarationsText("some random email body with no policy data");
    assert.equal(p.confidence < DECLARATIONS_REVIEW_THRESHOLD, true);
    assert.equal(declarationsNeedReview(p), true);
    assert.equal(p.policyNumber, null);
  });
  it("handles empty input as zero-confidence", () => {
    const p = parseDeclarationsText("");
    assert.equal(p.confidence, 0);
    assert.equal(declarationsNeedReview(p), true);
  });
});

describe("mock CoverForce vendor contract", () => {
  const vendor = new MockCoverForceVendor();
  it("exposes the fixture carriers", () => {
    assert.equal(MOCK_CARRIERS.length, 3);
    assert.ok(MOCK_CARRIERS.every((c) => c.appointmentPath === "dais_market_access"));
  });
  it("exposes fixture policies with honest statuses", () => {
    assert.equal(MOCK_POLICIES.length, 3);
    assert.ok(MOCK_POLICIES.some((p) => p.status === "pending_renewal"));
  });
  it("checkAppetite filters carriers by line", async () => {
    const gl = await vendor.checkAppetite({ line: "gl", state: "NC" });
    assert.ok(gl.carriers.includes("Chubb"));
    const cyber = await vendor.checkAppetite({ line: "cyber" });
    assert.deepEqual(cyber.carriers, ["Chubb"]);
  });
  it("submit requires an applicant name", async () => {
    await assert.rejects(
      () => vendor.submit({ line: "gl", applicantName: "  ", state: "NC" }),
      (e: unknown) => e instanceof InsuranceVendorError && e.code === "APPLICANT_REQUIRED",
    );
    const ok = await vendor.submit({ line: "gl", applicantName: "Acme LLC", state: "NC" });
    assert.ok(ok.submissionRef.startsWith("MOCK-SUB-"));
  });
  it("getQuotes returns quotes with declines as first-class outcomes", async () => {
    const quotes = await vendor.getQuotes({ submissionRef: "MOCK-SUB-X" });
    assert.equal(quotes.length, 3);
    const declined = quotes.find((q) => q.status === "declined");
    assert.ok(declined?.declineReason);
    const quoted = quotes.filter((q) => q.status === "quoted");
    assert.ok(quoted.every((q) => q.quotedPremiumCents != null && q.quotedPremiumCents > 0));
  });
  it("bind FAILS CLOSED with PARTNER_NOT_APPOINTED when no partner is given", async () => {
    await assert.rejects(
      () => vendor.bind({ quoteId: "Q-1", partnerId: "", idempotencyKey: "idem-1" }),
      (e: unknown) =>
        e instanceof InsuranceVendorError && e.code === "PARTNER_NOT_APPOINTED",
    );
  });
  it("bind with an appointed partner returns a fixture policy number", async () => {
    const result = await vendor.bind({ quoteId: "Q-1", partnerId: "partner-1", idempotencyKey: "idem-1" });
    assert.ok(result.policyNumber.startsWith("MOCK-POL-"));
    assert.ok(result.carrierConfirmation.startsWith("MOCK-CONF-"));
    assert.ok(result.paymentReference.startsWith("MOCK-PAY-"));
    assert.ok(result.premiumCents != null && result.premiumCents > 0);
  });
  it("bind requires an idempotency key", async () => {
    await assert.rejects(
      () => vendor.bind({ quoteId: "Q-1", partnerId: "partner-1", idempotencyKey: "  " }),
      (e: unknown) =>
        e instanceof InsuranceVendorError && e.code === "IDEMPOTENCY_KEY_REQUIRED",
    );
  });
  it("bind is deterministic per idempotency key (same key, same refs)", async () => {
    const a = await vendor.bind({ quoteId: "Q-1", partnerId: "partner-1", idempotencyKey: "idem-replay" });
    const b = await vendor.bind({ quoteId: "Q-1", partnerId: "partner-1", idempotencyKey: "idem-replay" });
    assert.equal(a.policyNumber, b.policyNumber);
    assert.equal(a.carrierConfirmation, b.carrierConfirmation);
    assert.equal(a.paymentReference, b.paymentReference);
  });
  it("issuePolicy delegates to bind in v1", async () => {
    const result = await vendor.issuePolicy({ quoteId: "Q-1", partnerId: "partner-1" });
    assert.ok(result.policyId.startsWith("MOCK-ISSUED-MOCK-POL-"));
    await assert.rejects(
      () => vendor.issuePolicy({ quoteId: "Q-1", partnerId: "" }),
      (e: unknown) =>
        e instanceof InsuranceVendorError && e.code === "PARTNER_NOT_APPOINTED",
    );
  });
});
