// Marketr — Wave 2 Insurance slice 3b tests: bind execution + zero-custody
// payment handoff + bound-quote → Policy lineage.
//
// Stub stores throughout: no database. Proves Tico's binding decisions for
// this domain:
// - executeBind is the ONLY execution entrypoint; every step fails closed
//   (quote → approval → licensed partner → vendor → persist → handoff → audit).
// - No explicit human approval, no bind (no auto-bind in v1).
// - The quote must not have drifted since approval (BIND_DISCLOSURE_MISMATCH).
// - No appointed licensed partner, no bind (PARTNER_NOT_APPOINTED).
// - Double-execution returns the existing policy — never double-binds.
// - Zero custody: the payment handoff documents carrier-direct movement and
//   asserts in code that no OS account fields exist on the record.
// - Bound quotes link to their policy (lineage), including prior-term
//   lineage for renewals.
// - The audit event gets the vendor transaction ref after execution.
//
// Run: npx tsx --test lib/insurance/__tests__/binding.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertDisclosureMatchesQuote,
  assertZeroCustodyHandoff,
  bindIdempotencyKey,
  CUSTODY_ASSERTION,
  executeBind,
  extractBindDisclosure,
  extractRenewalOfPolicyId,
  type BindingDeps,
  type BindPolicyRecord,
  type BindQuoteRecord,
  type NewBoundPolicy,
  type PaymentHandoffRecord,
} from "../binding";
import {
  approvalKindForAction,
  type ApprovalRecord,
  type GovernedApprovalStore,
} from "../governance";
import { InsuranceError } from "../types";
import {
  InsuranceVendorError,
  type InsuranceVendor,
  type VendorBindInput,
  type VendorBindResult,
} from "../mock-vendor";
import type { LicensedPartnerRecord, LicensedPartnerStore } from "../partner";

const WS = "ws_test";

const DISCLOSURE = {
  carrier: "Chubb",
  premiumCents: 512_000,
  limitPerOccurrenceCents: 100_000_000,
  limitAggregateCents: 200_000_000,
  effectiveDate: "2026-10-01",
};

// ---------------------------------------------------------------------------
// Stubs.
// ---------------------------------------------------------------------------

function makeQuote(overrides: Partial<BindQuoteRecord> = {}): BindQuoteRecord {
  return {
    id: "q1",
    workspaceId: WS,
    status: "quoted",
    carrierName: "Chubb",
    quotedPremiumCents: 512_000,
    limitPerOccurrenceCents: 100_000_000,
    limitAggregateCents: 200_000_000,
    quoteExpiry: new Date(Date.now() + 30 * 86400_000),
    rawPayload: {},
    policyId: null,
    submission: {
      id: "sub1",
      line: "gl",
      applicantName: "Acme Landscaping LLC",
      state: "NC",
    },
    ...overrides,
  };
}

function makeBindApproval(
  quote: BindQuoteRecord,
  overrides: Partial<ApprovalRecord> = {},
  disclosureOverrides: Record<string, unknown> = {},
): ApprovalRecord {
  return {
    id: "appr1",
    workspaceId: WS,
    kind: approvalKindForAction("bind_policy"),
    payload: {
      action: "bind_policy",
      subjectType: "quote",
      subjectId: quote.id,
      ...DISCLOSURE,
      ...disclosureOverrides,
    },
    status: "approved",
    requestedBy: "agent-1",
    decidedBy: "user-1",
    decidedAt: new Date("2026-10-01T12:00:00.000Z"),
    note: null,
    ...overrides,
  };
}

function makePartner(): LicensedPartnerRecord {
  return {
    id: "partner-1",
    workspaceId: WS,
    name: "Amwins DAIS",
    contactEmail: null,
    licenseNumber: "PL-12345",
    statesLicensed: ["NC"],
    appointmentPath: "dais_market_access",
    status: "active",
    appointedAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

interface StubVendor extends InsuranceVendor {
  bindCalls: VendorBindInput[];
}

function stubVendor(
  opts: { result?: Partial<VendorBindResult>; throwCode?: string } = {},
): StubVendor {
  const bindCalls: VendorBindInput[] = [];
  return {
    name: "mock",
    bindCalls,
    async checkAppetite() {
      return { carriers: [], notes: "" };
    },
    async submit() {
      return { submissionRef: "MOCK-SUB-1" };
    },
    async getQuotes() {
      return [];
    },
    async bind(input: VendorBindInput): Promise<VendorBindResult> {
      bindCalls.push(input);
      if (opts.throwCode) {
        throw new InsuranceVendorError(opts.throwCode, `vendor refused: ${opts.throwCode}`);
      }
      return {
        policyNumber: "MOCK-POL-TEST1",
        effectiveDate: "2026-10-01T00:00:00.000Z",
        carrierConfirmation: "MOCK-CONF-TEST1",
        premiumCents: 512_000,
        paymentReference: "MOCK-PAY-TEST1",
        ...opts.result,
      };
    },
    async issuePolicy(input: { quoteId: string; partnerId: string }) {
      const bound = await this.bind({
        quoteId: input.quoteId,
        partnerId: input.partnerId,
        idempotencyKey: `issue:${input.quoteId}:${input.partnerId}`,
      });
      return { policyId: `MOCK-ISSUED-${bound.policyNumber}` };
    },
    async getPolicyDocuments() {
      return { documents: [] };
    },
  };
}

interface StubWorld {
  quotes: Map<string, BindQuoteRecord>;
  policies: Map<string, BindPolicyRecord>;
  carrierNames: Map<string, string>;
  handoffs: Map<string, PaymentHandoffRecord>;
  approvals: Map<string, ApprovalRecord>;
  partners: LicensedPartnerRecord[];
  auditStamps: Array<{ subjectId: string; ref: string }>;
  vendor: StubVendor;
}

function stubWorld(): StubWorld {
  return {
    quotes: new Map(),
    policies: new Map(),
    carrierNames: new Map(),
    handoffs: new Map(),
    approvals: new Map(),
    partners: [],
    auditStamps: [],
    vendor: stubVendor(),
  };
}

/** Happy-path world: quoted quote + approved bind approval + partner. */
function happyWorld(): StubWorld {
  const world = stubWorld();
  const quote = makeQuote();
  world.quotes.set(quote.id, quote);
  world.approvals.set("appr1", makeBindApproval(quote));
  world.partners.push(makePartner());
  return world;
}

function stubDeps(world: StubWorld): BindingDeps {
  const partners: LicensedPartnerStore = {
    async getActivePartners(workspaceId) {
      return world.partners.filter((p) => p.workspaceId === workspaceId);
    },
    async list(workspaceId) {
      return world.partners.filter((p) => p.workspaceId === workspaceId);
    },
    async get(workspaceId, partnerId) {
      return (
        world.partners.find((p) => p.workspaceId === workspaceId && p.id === partnerId) ??
        null
      );
    },
    async create() {
      throw new Error("not implemented in stub");
    },
    async setStatus() {},
    async setLicensedStates() {
      throw new Error("not implemented in stub");
    },
  };
  const approvals: GovernedApprovalStore = {
    async create() {
      throw new Error("not implemented in stub");
    },
    async get(id, workspaceId) {
      const a = world.approvals.get(id);
      return a && a.workspaceId === workspaceId ? a : null;
    },
    async decide() {
      throw new Error("not implemented in stub");
    },
    async listPending() {
      return [];
    },
  };
  return {
    vendor: world.vendor,
    partners,
    approvals,
    quotes: {
      async get(workspaceId, quoteId) {
        const q = world.quotes.get(quoteId);
        return q && q.workspaceId === workspaceId ? q : null;
      },
      async markBound(workspaceId, quoteId, policyId) {
        const q = world.quotes.get(quoteId);
        if (!q || q.workspaceId !== workspaceId || q.status !== "quoted") {
          throw new InsuranceError("BIND_RACE_LOST", "quote is no longer quoted");
        }
        const next = { ...q, status: "bound", policyId };
        world.quotes.set(quoteId, next);
        return next;
      },
    },
    policies: {
      async get(workspaceId, policyId) {
        const p = world.policies.get(policyId);
        return p && p.workspaceId === workspaceId ? p : null;
      },
      async findByNumber(workspaceId, policyNumber) {
        return (
          [...world.policies.values()].find(
            (p) => p.workspaceId === workspaceId && p.policyNumber === policyNumber,
          ) ?? null
        );
      },
      async create(input: NewBoundPolicy) {
        const dup = [...world.policies.values()].some(
          (p) => p.workspaceId === input.workspaceId && p.policyNumber === input.policyNumber,
        );
        if (dup) throw new InsuranceError("POLICY_NUMBER_CONFLICT", "duplicate policy number");
        const rec: BindPolicyRecord = {
          id: `pol_${world.policies.size + 1}`,
          workspaceId: input.workspaceId,
          policyNumber: input.policyNumber,
          carrierName: world.carrierNames.get(input.carrierId) ?? "unknown",
          line: input.line,
          namedInsured: input.namedInsured,
          effectiveAt: input.effectiveAt,
          expiresAt: input.expiresAt,
          annualPremiumCents: input.annualPremiumCents,
          limitPerOccurrenceCents: input.limitPerOccurrenceCents,
          limitAggregateCents: input.limitAggregateCents,
          status: "active",
          source: input.source,
          priorPolicyId: input.priorPolicyId,
          rawPayload: input.rawPayload,
        };
        world.policies.set(rec.id, rec);
        return rec;
      },
    },
    carriers: {
      async upsert(workspaceId, name) {
        void workspaceId;
        const id = `carrier_${name}`;
        world.carrierNames.set(id, name);
        return { id, naicCode: "10052" };
      },
    },
    handoffs: {
      async create(input) {
        assertZeroCustodyHandoff(input as unknown as Record<string, unknown>);
        const rec: PaymentHandoffRecord = {
          id: `handoff_${world.handoffs.size + 1}`,
          workspaceId: input.workspaceId,
          policyId: input.policyId,
          amountCents: input.amountCents,
          payeeCarrier: input.payeeCarrier,
          payeeCarrierNaic: input.payeeCarrierNaic,
          vendorPaymentRef: input.vendorPaymentRef,
          custodyAssertion: input.custodyAssertion,
          createdAt: new Date("2026-10-01T13:00:00.000Z"),
        };
        world.handoffs.set(rec.policyId, rec);
        return rec;
      },
      async findByPolicy(workspaceId, policyId) {
        const h = world.handoffs.get(policyId);
        return h && h.workspaceId === workspaceId ? h : null;
      },
    },
    audit: {
      async stampVendorTransactionRef(workspaceId, subjectId, vendorTransactionRef) {
        void workspaceId;
        world.auditStamps.push({ subjectId, ref: vendorTransactionRef });
        return 1;
      },
    },
  };
}

async function rejectsCode(
  fn: () => Promise<unknown>,
  code: string,
): Promise<InsuranceError> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof InsuranceError, `expected InsuranceError, got ${e}`);
    assert.equal(
      (e as InsuranceError).code,
      code,
      `expected code ${code}, got ${(e as InsuranceError).code}: ${(e as Error).message}`,
    );
    return e as InsuranceError;
  }
  assert.fail(`expected rejection with code ${code}`);
}

// ---------------------------------------------------------------------------
// Disclosure helpers.
// ---------------------------------------------------------------------------

describe("bind disclosure helpers", () => {
  it("extractBindDisclosure accepts a complete disclosure", () => {
    const d = extractBindDisclosure({ ...DISCLOSURE });
    assert.equal(d.carrier, "Chubb");
    assert.equal(d.premiumCents, 512_000);
  });

  it("extractBindDisclosure fails closed on missing fields", () => {
    assert.throws(
      () => extractBindDisclosure({ carrier: "Chubb" }),
      (e: unknown) => e instanceof InsuranceError && e.code === "BIND_DISCLOSURE_INCOMPLETE",
    );
  });

  it("assertDisclosureMatchesQuote passes when nothing drifted", () => {
    assert.doesNotThrow(() =>
      assertDisclosureMatchesQuote(makeQuote(), extractBindDisclosure({ ...DISCLOSURE })),
    );
  });

  it("assertDisclosureMatchesQuote fails closed on premium drift", () => {
    const drifted = makeQuote({ quotedPremiumCents: 600_000 });
    assert.throws(
      () => assertDisclosureMatchesQuote(drifted, extractBindDisclosure({ ...DISCLOSURE })),
      (e: unknown) => e instanceof InsuranceError && e.code === "BIND_DISCLOSURE_MISMATCH",
    );
  });

  it("assertDisclosureMatchesQuote fails closed on carrier drift", () => {
    const drifted = makeQuote({ carrierName: "Travelers" });
    assert.throws(
      () => assertDisclosureMatchesQuote(drifted, extractBindDisclosure({ ...DISCLOSURE })),
      (e: unknown) => e instanceof InsuranceError && e.code === "BIND_DISCLOSURE_MISMATCH",
    );
  });

  it("extractRenewalOfPolicyId reads the lineage convention", () => {
    assert.equal(extractRenewalOfPolicyId({ renewalOfPolicyId: "pol_9" }), "pol_9");
    assert.equal(extractRenewalOfPolicyId({}), null);
    assert.equal(extractRenewalOfPolicyId(null), null);
  });

  it("bindIdempotencyKey derives from (quoteId, approvalId)", () => {
    assert.equal(bindIdempotencyKey("q1", "appr1"), "bind:q1:appr1");
  });
});

// ---------------------------------------------------------------------------
// Zero-custody assertion.
// ---------------------------------------------------------------------------

describe("assertZeroCustodyHandoff", () => {
  const canonical = {
    workspaceId: WS,
    policyId: "pol_1",
    amountCents: 512_000,
    payeeCarrier: "Chubb",
    payeeCarrierNaic: "10052",
    vendorPaymentRef: "MOCK-PAY-1",
    custodyAssertion: CUSTODY_ASSERTION,
  };

  it("accepts the canonical handoff shape", () => {
    assert.doesNotThrow(() => assertZeroCustodyHandoff({ ...canonical }));
    assert.equal(CUSTODY_ASSERTION, "carrier_direct");
  });

  it("rejects any OS account field", () => {
    for (const field of ["osAccountId", "routingNumber", "iban", "walletId", "balanceCents"]) {
      assert.throws(
        () => assertZeroCustodyHandoff({ ...canonical, [field]: "x" }),
        (e: unknown) => e instanceof InsuranceError && e.code === "ZERO_CUSTODY_VIOLATION",
        `field ${field} should be rejected`,
      );
    }
  });

  it("rejects unknown fields (closed schema)", () => {
    assert.throws(
      () => assertZeroCustodyHandoff({ ...canonical, memo: "hello" }),
      (e: unknown) => e instanceof InsuranceError && e.code === "ZERO_CUSTODY_VIOLATION",
    );
  });

  it("rejects anything but the carrier_direct assertion", () => {
    assert.throws(
      () => assertZeroCustodyHandoff({ ...canonical, custodyAssertion: "os_escrow" }),
      (e: unknown) => e instanceof InsuranceError && e.code === "ZERO_CUSTODY_VIOLATION",
    );
  });

  it("rejects a missing payee carrier", () => {
    assert.throws(
      () => assertZeroCustodyHandoff({ ...canonical, payeeCarrier: " " }),
      (e: unknown) => e instanceof InsuranceError && e.code === "ZERO_CUSTODY_VIOLATION",
    );
  });
});

// ---------------------------------------------------------------------------
// executeBind — fail-closed ordering.
// ---------------------------------------------------------------------------

describe("executeBind refusals", () => {
  it("refuses when the quote does not exist", async () => {
    const world = happyWorld();
    const err = await rejectsCode(
      () =>
        executeBind(
          { workspaceId: WS, quoteId: "nope", approvalId: "appr1" },
          stubDeps(world),
        ),
      "QUOTE_NOT_FOUND",
    );
    assert.ok(err.message.includes("not found"));
    assert.equal(world.vendor.bindCalls.length, 0);
  });

  it("refuses when the quote is not quoted", async () => {
    const world = happyWorld();
    world.quotes.set("q1", makeQuote({ status: "draft" }));
    await rejectsCode(
      () => executeBind({ workspaceId: WS, quoteId: "q1", approvalId: "appr1" }, stubDeps(world)),
      "QUOTE_NOT_QUOTED",
    );
    assert.equal(world.vendor.bindCalls.length, 0);
  });

  it("refuses an expired quote", async () => {
    const world = happyWorld();
    world.quotes.set("q1", makeQuote({ quoteExpiry: new Date(Date.now() - 1000) }));
    await rejectsCode(
      () => executeBind({ workspaceId: WS, quoteId: "q1", approvalId: "appr1" }, stubDeps(world)),
      "QUOTE_EXPIRED",
    );
    assert.equal(world.vendor.bindCalls.length, 0);
  });

  it("refuses without an approved approval (no auto-bind)", async () => {
    const world = happyWorld();
    const quote = world.quotes.get("q1")!;
    world.approvals.set("appr1", makeBindApproval(quote, { status: "pending" }));
    await rejectsCode(
      () => executeBind({ workspaceId: WS, quoteId: "q1", approvalId: "appr1" }, stubDeps(world)),
      "APPROVAL_NOT_APPROVED",
    );
    assert.equal(world.vendor.bindCalls.length, 0);
  });

  it("refuses a rejected approval", async () => {
    const world = happyWorld();
    const quote = world.quotes.get("q1")!;
    world.approvals.set("appr1", makeBindApproval(quote, { status: "rejected" }));
    await rejectsCode(
      () => executeBind({ workspaceId: WS, quoteId: "q1", approvalId: "appr1" }, stubDeps(world)),
      "APPROVAL_NOT_APPROVED",
    );
  });

  it("refuses an approval for a different quote", async () => {
    const world = happyWorld();
    const quote = world.quotes.get("q1")!;
    world.approvals.set(
      "appr1",
      makeBindApproval(quote, {}, { subjectId: "q-other" }),
    );
    await rejectsCode(
      () => executeBind({ workspaceId: WS, quoteId: "q1", approvalId: "appr1" }, stubDeps(world)),
      "APPROVAL_SUBJECT_MISMATCH",
    );
  });

  it("refuses when the quote drifted since approval", async () => {
    const world = happyWorld();
    // Premium changed after the human approved 512_000.
    world.quotes.set("q1", makeQuote({ quotedPremiumCents: 600_000 }));
    await rejectsCode(
      () => executeBind({ workspaceId: WS, quoteId: "q1", approvalId: "appr1" }, stubDeps(world)),
      "BIND_DISCLOSURE_MISMATCH",
    );
    assert.equal(world.vendor.bindCalls.length, 0);
  });

  it("refuses when the approval disclosure is incomplete at execution", async () => {
    const world = happyWorld();
    const quote = world.quotes.get("q1")!;
    const appr = makeBindApproval(quote);
    delete (appr.payload as Record<string, unknown>)["premiumCents"];
    world.approvals.set("appr1", appr);
    await rejectsCode(
      () => executeBind({ workspaceId: WS, quoteId: "q1", approvalId: "appr1" }, stubDeps(world)),
      "BIND_DISCLOSURE_INCOMPLETE",
    );
  });

  it("refuses without an appointed licensed partner", async () => {
    const world = happyWorld();
    world.partners = [];
    await rejectsCode(
      () => executeBind({ workspaceId: WS, quoteId: "q1", approvalId: "appr1" }, stubDeps(world)),
      "PARTNER_NOT_APPOINTED",
    );
    // The partner gate fires before any vendor contact.
    assert.equal(world.vendor.bindCalls.length, 0);
  });

  it("propagates vendor refusals with their codes", async () => {
    const world = happyWorld();
    world.vendor = stubVendor({ throwCode: "VENDOR_NOT_CONFIGURED" });
    await rejectsCode(
      () => executeBind({ workspaceId: WS, quoteId: "q1", approvalId: "appr1" }, stubDeps(world)),
      "VENDOR_NOT_CONFIGURED",
    );
    assert.equal(world.policies.size, 0);
  });
});

// ---------------------------------------------------------------------------
// executeBind — happy path, idempotency, lineage, audit.
// ---------------------------------------------------------------------------

describe("executeBind success", () => {
  it("binds: policy from vendor data, quote → bound, handoff, audit stamp", async () => {
    const world = happyWorld();
    const deps = stubDeps(world);

    const result = await executeBind(
      { workspaceId: WS, quoteId: "q1", approvalId: "appr1", requestedBy: "user-1" },
      deps,
    );

    // Vendor called exactly once, with the partner and the idempotency key.
    assert.equal(world.vendor.bindCalls.length, 1);
    const call = world.vendor.bindCalls[0]!;
    assert.equal(call.quoteId, "q1");
    assert.equal(call.partnerId, "partner-1");
    assert.equal(call.idempotencyKey, "bind:q1:appr1");

    // Policy copied from VENDOR data only: number/premium/dates from the
    // bind response; limits "not confirmed" (v1 response carries none).
    const policy = result.policy;
    assert.equal(policy.policyNumber, "MOCK-POL-TEST1");
    assert.equal(policy.annualPremiumCents, 512_000);
    assert.equal(policy.limitPerOccurrenceCents, null);
    assert.equal(policy.limitAggregateCents, null);
    assert.equal(policy.carrierName, "Chubb");
    assert.equal(policy.namedInsured, "Acme Landscaping LLC");
    assert.equal(policy.line, "gl");
    assert.equal(policy.status, "active");
    assert.equal(policy.priorPolicyId, null);
    assert.ok(policy.effectiveAt.getTime() > 0);
    assert.ok(policy.expiresAt.getTime() > policy.effectiveAt.getTime());

    // Quote → policy lineage.
    const quote = world.quotes.get("q1")!;
    assert.equal(quote.status, "bound");
    assert.equal(quote.policyId, policy.id);

    // Zero-custody payment handoff.
    const handoff = result.paymentHandoff;
    assert.equal(handoff.policyId, policy.id);
    assert.equal(handoff.amountCents, 512_000);
    assert.equal(handoff.payeeCarrier, "Chubb");
    assert.equal(handoff.custodyAssertion, "carrier_direct");
    assert.equal(handoff.vendorPaymentRef, "MOCK-PAY-TEST1");

    // Audit event stamped with the vendor transaction ref.
    assert.deepEqual(world.auditStamps, [{ subjectId: "q1", ref: "MOCK-CONF-TEST1" }]);

    assert.equal(result.replayed, false);
    assert.equal(result.live, false);
  });

  it("double execution returns the existing policy — never double-binds", async () => {
    const world = happyWorld();
    const deps = stubDeps(world);

    const first = await executeBind(
      { workspaceId: WS, quoteId: "q1", approvalId: "appr1" },
      deps,
    );
    const second = await executeBind(
      { workspaceId: WS, quoteId: "q1", approvalId: "appr1" },
      deps,
    );

    assert.equal(second.replayed, true);
    assert.equal(second.policy.id, first.policy.id);
    assert.equal(second.paymentHandoff.id, first.paymentHandoff.id);
    assert.equal(world.vendor.bindCalls.length, 1);
    assert.equal(world.policies.size, 1);
    assert.equal(world.handoffs.size, 1);
  });

  it("sets priorPolicyId when the quote renews an existing policy", async () => {
    const world = happyWorld();
    // Prior term policy already in the workspace.
    const prior: BindPolicyRecord = {
      id: "pol_prior",
      workspaceId: WS,
      policyNumber: "GL-2025-000111",
      carrierName: "Chubb",
      line: "gl",
      namedInsured: "Acme Landscaping LLC",
      effectiveAt: new Date("2025-10-01T00:00:00.000Z"),
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      annualPremiumCents: 485_000,
      limitPerOccurrenceCents: 100_000_000,
      limitAggregateCents: 200_000_000,
      status: "active",
      source: "mock",
      priorPolicyId: null,
      rawPayload: {},
    };
    world.policies.set(prior.id, prior);
    world.quotes.set(
      "q1",
      makeQuote({ rawPayload: { renewalOfPolicyId: "pol_prior" } }),
    );

    const result = await executeBind(
      { workspaceId: WS, quoteId: "q1", approvalId: "appr1" },
      stubDeps(world),
    );
    assert.equal(result.policy.priorPolicyId, "pol_prior");
  });

  it("leaves priorPolicyId null (no throw) when the renewal ref is unresolved", async () => {
    const world = happyWorld();
    world.quotes.set(
      "q1",
      makeQuote({ rawPayload: { renewalOfPolicyId: "pol_missing" } }),
    );

    const result = await executeBind(
      { workspaceId: WS, quoteId: "q1", approvalId: "appr1" },
      stubDeps(world),
    );
    assert.equal(result.policy.priorPolicyId, null);
    assert.equal(
      (result.policy.rawPayload as Record<string, unknown>)["renewalOfPolicyIdUnresolved"],
      "pol_missing",
    );
  });
});
