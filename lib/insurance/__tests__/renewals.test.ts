// Marketr — Wave 2 Insurance slice 4 tests: renewal remarketing workflow.
//
// Stub stores throughout: no database. Proves SPEC-INSURANCE.md §4.3 (renew):
// - the remarket state machine fails closed on illegal transitions;
// - startRemarket creates a submission pre-filled from the expiring policy
//   and gates it through the request_quote governed action (approval, or a
//   pre-approved standing rule);
// - recordRenewalQuotes computes the premium delta vs the prior term and
//   flags above-threshold premiums before any renewal approval;
// - auto-renewals are surfaced, never silently accepted — the terminal state
//   can never move to bound.
//
// Run: npx tsx --test lib/insurance/__tests__/renewals.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  advanceRemarket,
  recordRenewalQuotes,
  startRemarket,
  surfaceAutoRenew,
  type ApprovalRecord,
  type GovernanceStores,
  type PersistedVendorQuote,
  type RemarketQuoteLite,
  type RemarketSubmissionRecord,
  type RenewalGateLookups,
  type RenewalRecord,
  type RenewalStore,
  type RenewalStores,
  type SubmissionCreateInput,
  type SubmissionUpdate,
  type RenewalUpdate,
} from "../renewals";
import type { QuoteRuleRecord } from "../governance";
import { InsuranceError } from "../types";
import type { InsuranceVendor } from "../mock-vendor";

const WS = "ws_test";
const ACTOR = "user_test";

function renewalFixture(
  overrides: Partial<RenewalRecord> = {},
): RenewalRecord {
  return {
    id: "ren_1",
    workspaceId: WS,
    policyId: "pol_1",
    renewalDate: new Date("2026-12-01T00:00:00.000Z"),
    remarketStatus: "detected",
    priorPremiumCents: 100_000,
    newPremiumCents: null,
    premiumDeltaPct: null,
    autoRenewTerms: null,
    policy: {
      id: "pol_1",
      policyNumber: "GL-2025-001",
      line: "gl",
      namedInsured: "Acme Landscaping LLC",
      carrierName: "AmTrust",
      limitPerOccurrenceCents: 100_000_000,
      limitAggregateCents: 200_000_000,
      annualPremiumCents: 100_000,
      effectiveAt: new Date("2025-12-01T00:00:00.000Z"),
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    },
    ...overrides,
  };
}

interface StubBundle {
  stores: RenewalStores;
  renewalsMap: Map<string, RenewalRecord>;
  submissionsMap: Map<string, RemarketSubmissionRecord>;
  quotesMap: Map<string, RemarketQuoteLite[]>;
  createdApprovals: ApprovalRecord[];
  approvedRequestQuote: { value: boolean };
  quoteRulesMap: Map<string, QuoteRuleRecord>;
}

function stubStores(): StubBundle {
  const renewalsMap = new Map<string, RenewalRecord>();
  const submissionsMap = new Map<string, RemarketSubmissionRecord>();
  const quotesMap = new Map<string, RemarketQuoteLite[]>();
  const createdApprovals: ApprovalRecord[] = [];
  const quoteRulesMap = new Map<string, QuoteRuleRecord>();
  const approvedRequestQuote = { value: false };
  let seq = 0;

  const renewalStore: RenewalStore = {
    async get(id, workspaceId) {
      const r = renewalsMap.get(id);
      return r && r.workspaceId === workspaceId ? { ...r } : null;
    },
    async update(id, workspaceId, data: RenewalUpdate) {
      const r = renewalsMap.get(id);
      if (!r || r.workspaceId !== workspaceId) throw new Error("not found");
      const next: RenewalRecord = {
        ...r,
        ...(data.remarketStatus !== undefined
          ? { remarketStatus: data.remarketStatus }
          : {}),
        ...(data.newPremiumCents !== undefined
          ? { newPremiumCents: data.newPremiumCents }
          : {}),
        ...(data.premiumDeltaPct !== undefined
          ? { premiumDeltaPct: data.premiumDeltaPct }
          : {}),
        ...(data.autoRenewTerms !== undefined
          ? { autoRenewTerms: data.autoRenewTerms }
          : {}),
      };
      renewalsMap.set(id, next);
      return { ...next };
    },
    async findSubmissionForRenewal(renewalId, workspaceId) {
      for (const s of submissionsMap.values()) {
        if (s.renewalId === renewalId && s.workspaceId === workspaceId) {
          return { ...s };
        }
      }
      return null;
    },
    async createSubmission(input: SubmissionCreateInput) {
      const rec: RemarketSubmissionRecord = {
        id: `sub_${++seq}`,
        workspaceId: input.workspaceId,
        renewalId: input.renewalId,
        line: input.line,
        applicantName: input.applicantName,
        state: input.state,
        status: input.status,
        vendorRef: null,
        submittedBy: input.submittedBy,
      };
      submissionsMap.set(rec.id, rec);
      return { ...rec };
    },
    async updateSubmission(id, workspaceId, data: SubmissionUpdate) {
      const s = submissionsMap.get(id);
      if (!s || s.workspaceId !== workspaceId) throw new Error("not found");
      const next = {
        ...s,
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.vendorRef !== undefined ? { vendorRef: data.vendorRef } : {}),
      };
      submissionsMap.set(id, next);
      return { ...next };
    },
    async listQuotesBySubmission(submissionId, _workspaceId) {
      return (quotesMap.get(submissionId) ?? []).map((q) => ({ ...q }));
    },
    async createQuotes(submissionId, _workspaceId, qs: PersistedVendorQuote[]) {
      const list = quotesMap.get(submissionId) ?? [];
      qs.forEach((q, i) => {
        list.push({
          id: `q_${submissionId}_${i}`,
          carrierName: q.carrierName,
          quotedPremiumCents: q.quotedPremiumCents,
          limitPerOccurrenceCents: q.limitPerOccurrenceCents,
          limitAggregateCents: q.limitAggregateCents,
          status: q.status,
        });
      });
      quotesMap.set(submissionId, list);
    },
  };

  const governance: GovernanceStores = {
    approvals: {
      async create(input) {
        const rec: ApprovalRecord = {
          id: `appr_${++seq}`,
          workspaceId: input.workspaceId,
          kind: input.kind,
          payload: input.payload,
          status: "pending",
          requestedBy: input.requestedBy ?? null,
          decidedBy: null,
          decidedAt: null,
          note: null,
        };
        createdApprovals.push(rec);
        return rec;
      },
      async get() {
        throw new Error("not implemented in stub");
      },
      async decide() {
        throw new Error("not implemented in stub");
      },
      async listPending() {
        return [];
      },
    },
    audit: {
      async create(input) {
        return {
          id: `audit_${++seq}`,
          workspaceId: input.workspaceId,
          action: input.action,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          result: input.result,
          decidedBy: input.decidedBy,
          decidedAt: input.decidedAt,
          payload: input.payload,
          vendorTransactionRef: input.vendorTransactionRef ?? null,
          note: input.note ?? null,
        };
      },
    },
    quoteRules: {
      async find(workspaceId, lineOfBusiness) {
        return quoteRulesMap.get(`${workspaceId}:${lineOfBusiness}`) ?? null;
      },
      async upsert(workspaceId, lineOfBusiness, approvedBy) {
        const rec: QuoteRuleRecord = {
          id: `rule_${++seq}`,
          workspaceId,
          lineOfBusiness,
          approvedBy: approvedBy ?? null,
          createdAt: new Date("2026-10-01T12:00:00.000Z"),
        };
        quoteRulesMap.set(`${workspaceId}:${lineOfBusiness}`, rec);
        return rec;
      },
      async list(workspaceId) {
        return [...quoteRulesMap.values()].filter(
          (r) => r.workspaceId === workspaceId,
        );
      },
    },
  };

  const gates: RenewalGateLookups = {
    async findApprovedRequestQuote(workspaceId, submissionId) {
      if (!approvedRequestQuote.value) return null;
      return {
        id: "appr_approved_1",
        workspaceId,
        kind: "insurance_request_quote",
        payload: {
          action: "request_quote",
          subjectType: "quote",
          subjectId: submissionId,
        },
        status: "approved",
        requestedBy: ACTOR,
        decidedBy: ACTOR,
        decidedAt: new Date("2026-10-01T12:00:00.000Z"),
        note: null,
      };
    },
  };

  return {
    stores: { renewals: renewalStore, governance, gates },
    renewalsMap,
    submissionsMap,
    quotesMap,
    createdApprovals,
    approvedRequestQuote,
    quoteRulesMap,
  };
}

/** Fixture vendor returning canned quotes for a submission. */
function stubVendor(
  vendorQuotes: Array<{
    carrierName: string;
    quotedPremiumCents: number | null;
    status: "quoted" | "declined" | "referred";
  }>,
): InsuranceVendor {
  return {
    name: "mock",
    async checkAppetite() {
      return { carriers: [], notes: "" };
    },
    async submit() {
      return { submissionRef: "fixture-sub-1" };
    },
    async getQuotes() {
      return vendorQuotes.map((q) => ({
        carrierName: q.carrierName,
        quotedPremiumCents: q.quotedPremiumCents,
        limitPerOccurrenceCents: 100_000_000,
        limitAggregateCents: 200_000_000,
        quoteExpiry: "2026-12-31T00:00:00.000Z",
        status: q.status,
      }));
    },
    async bind() {
      throw new Error("not implemented in stub");
    },
    async issuePolicy() {
      throw new Error("not implemented in stub");
    },
    async getPolicyDocuments() {
      return { documents: [] };
    },
  };
}

async function expectInsuranceError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<InsuranceError> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof InsuranceError, `expected InsuranceError, got ${e}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`expected InsuranceError(${code}) but nothing threw`);
}

describe("advanceRemarket", () => {
  it("fails closed on an illegal transition (detected → bound)", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture());
    await expectInsuranceError(
      () => advanceRemarket(WS, "ren_1", "bound", ACTOR, { stores: s.stores }),
      "ILLEGAL_REMARKET_TRANSITION",
    );
  });

  it("rejects an unknown target status", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture());
    await expectInsuranceError(
      () => advanceRemarket(WS, "ren_1", "renewed", ACTOR, { stores: s.stores }),
      "UNKNOWN_RENEWAL",
    );
  });

  it("rejects a missing renewal", async () => {
    const s = stubStores();
    await expectInsuranceError(
      () => advanceRemarket(WS, "nope", "remarketing", ACTOR, { stores: s.stores }),
      "RENEWAL_NOT_FOUND",
    );
  });

  it("refuses a bare transition into auto_renew_surfaced (silent acceptance)", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture());
    await expectInsuranceError(
      () =>
        advanceRemarket(WS, "ren_1", "auto_renew_surfaced", ACTOR, {
          stores: s.stores,
        }),
      "ILLEGAL_REMARKET_TRANSITION",
    );
  });

  it("advances detected → remarketing", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture());
    const updated = await advanceRemarket(WS, "ren_1", "remarketing", ACTOR, {
      stores: s.stores,
    });
    assert.equal(updated.remarketStatus, "remarketing");
  });

  it("refuses to mark bound until a linked quote is actually bound", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture({ remarketStatus: "quoted" }));
    s.submissionsMap.set("sub_1", {
      id: "sub_1",
      workspaceId: WS,
      renewalId: "ren_1",
      line: "gl",
      applicantName: "Acme Landscaping LLC",
      state: "NC",
      status: "quoted",
      vendorRef: "fixture-sub-1",
      submittedBy: ACTOR,
    });
    s.quotesMap.set("sub_1", [
      {
        id: "q_1",
        carrierName: "AmTrust",
        quotedPremiumCents: 115_000,
        limitPerOccurrenceCents: 100_000_000,
        limitAggregateCents: 200_000_000,
        status: "quoted",
      },
    ]);
    await expectInsuranceError(
      () => advanceRemarket(WS, "ren_1", "bound", ACTOR, { stores: s.stores }),
      "BIND_APPROVAL_REQUIRED",
    );
    // Once the quote is bound through the approvals flow, the transition lands.
    s.quotesMap.set("sub_1", [
      {
        id: "q_1",
        carrierName: "AmTrust",
        quotedPremiumCents: 115_000,
        limitPerOccurrenceCents: 100_000_000,
        limitAggregateCents: 200_000_000,
        status: "bound",
      },
    ]);
    const updated = await advanceRemarket(WS, "ren_1", "bound", ACTOR, {
      stores: s.stores,
    });
    assert.equal(updated.remarketStatus, "bound");
  });
});

describe("startRemarket", () => {
  it("creates a pre-filled submission and a request_quote governed action", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture());
    const result = await startRemarket(WS, "ren_1", ACTOR, {
      stores: s.stores,
      state: "nc",
    });

    assert.equal(result.standingRuleCovered, false);
    assert.equal(result.renewal.remarketStatus, "remarketing");

    // Submission pre-filled from the expiring policy, linked to the renewal.
    assert.equal(result.submission.renewalId, "ren_1");
    assert.equal(result.submission.line, "gl");
    assert.equal(result.submission.applicantName, "Acme Landscaping LLC");
    assert.equal(result.submission.state, "NC");
    assert.equal(result.submission.status, "draft");
    assert.equal(result.submission.submittedBy, ACTOR);

    // The request_quote governed action was proposed against the submission.
    assert.ok(result.approval);
    assert.equal(result.approval.kind, "insurance_request_quote");
    const payload = result.approval.payload as Record<string, unknown>;
    assert.equal(payload["subjectId"], result.submission.id);
    assert.equal(payload["action"], "request_quote");
    assert.equal(payload["renewalId"], "ren_1");
    assert.equal(s.createdApprovals.length, 1);
  });

  it("honors a standing quote rule instead of proposing an approval", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture());
    await s.stores.governance.quoteRules.upsert(WS, "gl", ACTOR);

    const result = await startRemarket(WS, "ren_1", ACTOR, {
      stores: s.stores,
      state: "NC",
    });

    assert.equal(result.standingRuleCovered, true);
    assert.equal(result.approval, null);
    assert.equal(s.createdApprovals.length, 0);
    assert.equal(result.renewal.remarketStatus, "remarketing");
  });

  it("fails closed without an explicit 2-letter state", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture());
    await expectInsuranceError(
      () => startRemarket(WS, "ren_1", ACTOR, { stores: s.stores }),
      "RENEWAL_STATE_REQUIRED",
    );
    await expectInsuranceError(
      () => startRemarket(WS, "ren_1", ACTOR, { stores: s.stores, state: "XX1" }),
      "RENEWAL_STATE_REQUIRED",
    );
  });

  it("refuses to remarket twice", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture({ remarketStatus: "remarketing" }));
    await expectInsuranceError(
      () => startRemarket(WS, "ren_1", ACTOR, { stores: s.stores, state: "NC" }),
      "ILLEGAL_REMARKET_TRANSITION",
    );
  });

  it("rejects a missing renewal", async () => {
    const s = stubStores();
    await expectInsuranceError(
      () => startRemarket(WS, "nope", ACTOR, { stores: s.stores, state: "NC" }),
      "RENEWAL_NOT_FOUND",
    );
  });
});

describe("recordRenewalQuotes", () => {
  it("pulls quotes under a standing rule and flags an above-threshold delta", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture({ remarketStatus: "remarketing" }));
    s.submissionsMap.set("sub_1", {
      id: "sub_1",
      workspaceId: WS,
      renewalId: "ren_1",
      line: "gl",
      applicantName: "Acme Landscaping LLC",
      state: "NC",
      status: "draft",
      vendorRef: null,
      submittedBy: ACTOR,
    });
    await s.stores.governance.quoteRules.upsert(WS, "gl", ACTOR);
    const vendor = stubVendor([
      { carrierName: "AmTrust", quotedPremiumCents: 115_000, status: "quoted" },
      { carrierName: "Travelers", quotedPremiumCents: 121_000, status: "quoted" },
    ]);

    const { renewal, quotes, deltaFlagged } = await recordRenewalQuotes(
      WS,
      "ren_1",
      { stores: s.stores, vendor },
    );

    // Best priced premium (115000) vs prior 100000 → +15%, above the 10% bar.
    assert.equal(renewal.newPremiumCents, 115_000);
    assert.equal(renewal.premiumDeltaPct, 15);
    assert.equal(deltaFlagged, true);
    assert.equal(renewal.remarketStatus, "quoted");
    assert.equal(quotes.length, 2);
    const sub = s.submissionsMap.get("sub_1")!;
    assert.equal(sub.status, "quoted");
    assert.equal(sub.vendorRef, "fixture-sub-1");
  });

  it("does not flag a below-threshold delta", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture({ remarketStatus: "remarketing" }));
    s.submissionsMap.set("sub_1", {
      id: "sub_1",
      workspaceId: WS,
      renewalId: "ren_1",
      line: "gl",
      applicantName: "Acme Landscaping LLC",
      state: "NC",
      status: "draft",
      vendorRef: null,
      submittedBy: ACTOR,
    });
    await s.stores.governance.quoteRules.upsert(WS, "gl", ACTOR);
    const vendor = stubVendor([
      { carrierName: "AmTrust", quotedPremiumCents: 105_000, status: "quoted" },
    ]);

    const { renewal, deltaFlagged } = await recordRenewalQuotes(WS, "ren_1", {
      stores: s.stores,
      vendor,
    });

    assert.equal(renewal.premiumDeltaPct, 5);
    assert.equal(deltaFlagged, false);
  });

  it("proceeds on an approved request_quote approval without a standing rule", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture({ remarketStatus: "remarketing" }));
    s.submissionsMap.set("sub_1", {
      id: "sub_1",
      workspaceId: WS,
      renewalId: "ren_1",
      line: "gl",
      applicantName: "Acme Landscaping LLC",
      state: "NC",
      status: "draft",
      vendorRef: null,
      submittedBy: ACTOR,
    });
    s.approvedRequestQuote.value = true;
    const vendor = stubVendor([
      { carrierName: "AmTrust", quotedPremiumCents: 98_000, status: "quoted" },
    ]);

    const { renewal } = await recordRenewalQuotes(WS, "ren_1", {
      stores: s.stores,
      vendor,
    });
    assert.equal(renewal.remarketStatus, "quoted");
    assert.equal(renewal.newPremiumCents, 98_000);
  });

  it("refuses the first pull when the request_quote gate is not satisfied", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture({ remarketStatus: "remarketing" }));
    s.submissionsMap.set("sub_1", {
      id: "sub_1",
      workspaceId: WS,
      renewalId: "ren_1",
      line: "gl",
      applicantName: "Acme Landscaping LLC",
      state: "NC",
      status: "draft",
      vendorRef: null,
      submittedBy: ACTOR,
    });
    const vendor = stubVendor([
      { carrierName: "AmTrust", quotedPremiumCents: 115_000, status: "quoted" },
    ]);
    await expectInsuranceError(
      () => recordRenewalQuotes(WS, "ren_1", { stores: s.stores, vendor }),
      "REQUEST_QUOTE_NOT_APPROVED",
    );
  });

  it("refuses to record when no priced quotes came back", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture({ remarketStatus: "remarketing" }));
    s.submissionsMap.set("sub_1", {
      id: "sub_1",
      workspaceId: WS,
      renewalId: "ren_1",
      line: "gl",
      applicantName: "Acme Landscaping LLC",
      state: "NC",
      status: "draft",
      vendorRef: null,
      submittedBy: ACTOR,
    });
    await s.stores.governance.quoteRules.upsert(WS, "gl", ACTOR);
    const vendor = stubVendor([
      { carrierName: "AmTrust", quotedPremiumCents: null, status: "declined" },
    ]);
    await expectInsuranceError(
      () => recordRenewalQuotes(WS, "ren_1", { stores: s.stores, vendor }),
      "NO_RENEWAL_QUOTES",
    );
  });

  it("refuses outside the remarketing window", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture({ remarketStatus: "detected" }));
    await expectInsuranceError(
      () => recordRenewalQuotes(WS, "ren_1", { stores: s.stores }),
      "ILLEGAL_REMARKET_TRANSITION",
    );
  });
});

describe("surfaceAutoRenew", () => {
  it("surfaces the carrier terms, flags the delta, and never auto-accepts", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture());
    const terms = {
      premiumCents: 118_000,
      limitPerOccurrenceCents: 100_000_000,
      limitAggregateCents: 200_000_000,
      effectiveDate: "2026-12-01",
      expiryDate: "2027-12-01",
      carrierName: "AmTrust",
    };

    const { renewal, deltaFlagged, needsReview } = await surfaceAutoRenew(
      WS,
      "ren_1",
      terms,
      { stores: s.stores },
    );

    assert.equal(renewal.remarketStatus, "auto_renew_surfaced");
    assert.deepEqual(renewal.autoRenewTerms, terms);
    assert.equal(renewal.newPremiumCents, 118_000);
    assert.equal(renewal.premiumDeltaPct, 18);
    assert.equal(deltaFlagged, true);
    assert.equal(needsReview, true);

    // Terminal: nothing leaves auto_renew_surfaced — it can never be bound
    // through the remarket machine.
    for (const target of ["remarketing", "quoted", "bound", "detected"]) {
      await expectInsuranceError(
        () => advanceRemarket(WS, "ren_1", target, ACTOR, { stores: s.stores }),
        "ILLEGAL_REMARKET_TRANSITION",
      );
    }
  });

  it("refuses an empty terms snapshot (silent acceptance)", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture());
    await expectInsuranceError(
      () => surfaceAutoRenew(WS, "ren_1", {}, { stores: s.stores }),
      "AUTO_RENEW_TERMS_REQUIRED",
    );
  });

  it("only surfaces from detected", async () => {
    const s = stubStores();
    s.renewalsMap.set("ren_1", renewalFixture({ remarketStatus: "remarketing" }));
    await expectInsuranceError(
      () =>
        surfaceAutoRenew(WS, "ren_1", { premiumCents: 100_000 }, { stores: s.stores }),
      "ILLEGAL_REMARKET_TRANSITION",
    );
  });
});
