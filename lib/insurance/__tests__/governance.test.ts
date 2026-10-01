// Marketr — Wave 2 Insurance slice 3a tests: governed-action approval + audit.
//
// Stub stores throughout: no database. Proves Tico's binding decisions for
// this domain:
// - the agent prepares, the human approves, the licensed rail executes;
// - bind_policy requires explicit per-transaction human approval — a standing
//   rule for bind_policy is a hard refusal (no auto-bind in v1);
// - only pending approvals are decidable; deciding twice fails;
// - EVERY decision (approved or denied) writes a complete audit record
//   (who approved, what, timestamp).
//
// Run: npx tsx --test lib/insurance/__tests__/governance.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  actionForApprovalKind,
  approvalKindForAction,
  decideGovernedAction,
  getPendingApprovals,
  proposeGovernedAction,
  proposeStandingRule,
  requestQuoteCovered,
  validateBindDisclosure,
  type ApprovalRecord,
  type AuditEventRecord,
  type GovernedAction,
  type GovernedApprovalStore,
  type GovernedSubjectType,
  type GovernanceStores,
  type InsuranceAuditStore,
  type InsuranceQuoteRuleStore,
  type QuoteRuleRecord,
} from "../governance";
import { InsuranceError } from "../types";

const WS = "ws_test";

function stubStores(): GovernanceStores & {
  approvals: { items: Map<string, ApprovalRecord> };
  audit: { events: AuditEventRecord[] };
  quoteRules: { rules: Map<string, QuoteRuleRecord> };
} {
  const items = new Map<string, ApprovalRecord>();
  const events: AuditEventRecord[] = [];
  const rules = new Map<string, QuoteRuleRecord>();
  let seq = 0;

  const approvals: GovernedApprovalStore & { items: Map<string, ApprovalRecord> } = {
    items,
    async create(input) {
      const id = `appr_${++seq}`;
      const rec: ApprovalRecord = {
        id,
        workspaceId: input.workspaceId,
        kind: input.kind,
        payload: input.payload,
        status: "pending",
        requestedBy: input.requestedBy ?? null,
        decidedBy: null,
        decidedAt: null,
        note: null,
      };
      items.set(id, rec);
      return rec;
    },
    async get(id, workspaceId) {
      const rec = items.get(id);
      return rec && rec.workspaceId === workspaceId ? rec : null;
    },
    async decide(id, workspaceId, decision, decidedBy, note) {
      const rec = items.get(id);
      if (!rec || rec.workspaceId !== workspaceId) throw new Error("not found");
      if (rec.status !== "pending") throw new Error(`already ${rec.status}`);
      const next: ApprovalRecord = {
        ...rec,
        status: decision === "approve" ? "approved" : "rejected",
        decidedBy: decidedBy ?? null,
        decidedAt: new Date("2026-10-01T12:00:00.000Z"),
        note: note ?? null,
      };
      items.set(id, next);
      return next;
    },
    async listPending(workspaceId, kinds) {
      return [...items.values()].filter(
        (r) => r.workspaceId === workspaceId && r.status === "pending" && kinds.includes(r.kind),
      );
    },
  };

  const audit: InsuranceAuditStore & { events: AuditEventRecord[] } = {
    events,
    async create(input) {
      const rec: AuditEventRecord = {
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
      events.push(rec);
      return rec;
    },
  };

  const quoteRules: InsuranceQuoteRuleStore & { rules: Map<string, QuoteRuleRecord> } = {
    rules,
    async find(workspaceId, lineOfBusiness) {
      return rules.get(`${workspaceId}:${lineOfBusiness}`) ?? null;
    },
    async upsert(workspaceId, lineOfBusiness, approvedBy) {
      const rec: QuoteRuleRecord = {
        id: `rule_${++seq}`,
        workspaceId,
        lineOfBusiness,
        approvedBy: approvedBy ?? null,
        createdAt: new Date("2026-10-01T12:00:00.000Z"),
      };
      rules.set(`${workspaceId}:${lineOfBusiness}`, rec);
      return rec;
    },
    async list(workspaceId) {
      return [...rules.values()].filter((r) => r.workspaceId === workspaceId);
    },
  };

  return { approvals, audit, quoteRules };
}

const BIND_DETAILS = {
  carrier: "Acme Mutual",
  premiumCents: 125000,
  limitPerOccurrenceCents: 100000000,
  limitAggregateCents: 200000000,
  effectiveDate: "2026-11-01",
  expiryDate: "2027-11-01",
  lineOfBusiness: "gl",
};

describe("governed action kinds", () => {
  it("maps each governed action to a namespaced approval kind", () => {
    assert.equal(approvalKindForAction("request_quote"), "insurance_request_quote");
    assert.equal(approvalKindForAction("bind_policy"), "insurance_bind_policy");
    assert.equal(approvalKindForAction("issue_certificate"), "insurance_issue_certificate");
  });

  it("reverses kind → action, and rejects foreign kinds", () => {
    assert.equal(actionForApprovalKind("insurance_bind_policy"), "bind_policy");
    assert.equal(actionForApprovalKind("sequence_send"), null);
  });
});

describe("proposeGovernedAction", () => {
  it("bind_policy requires per-transaction approval: creates an insurance_bind_policy ApprovalItem", async () => {
    const stores = stubStores();
    const approval = await proposeGovernedAction(
      WS,
      "bind_policy",
      { subjectType: "quote", subjectId: "q_1" },
      BIND_DETAILS,
      "agent_1",
      stores,
    );
    assert.equal(approval.kind, "insurance_bind_policy");
    assert.equal(approval.status, "pending");
    const payload = approval.payload as Record<string, unknown>;
    assert.equal(payload["action"], "bind_policy");
    assert.equal(payload["subjectId"], "q_1");
    assert.equal(payload["carrier"], "Acme Mutual");
  });

  it("rejects unknown actions fail-closed", async () => {
    const stores = stubStores();
    await assert.rejects(
      () =>
        proposeGovernedAction(
          WS,
          "auto_bind",
          { subjectType: "quote", subjectId: "q_1" },
          {},
          "agent_1",
          stores,
        ),
      (e) => e instanceof InsuranceError && e.code === "UNKNOWN_GOVERNED_ACTION",
    );
  });

  it("rejects bind_policy proposals missing disclosure (fail closed)", async () => {
    const stores = stubStores();
    await assert.rejects(
      () =>
        proposeGovernedAction(
          WS,
          "bind_policy",
          { subjectType: "quote", subjectId: "q_1" },
          { carrier: "Acme Mutual" }, // missing premium/limits/effectiveDate
          "agent_1",
          stores,
        ),
      (e) => e instanceof InsuranceError && e.code === "BIND_DISCLOSURE_INCOMPLETE",
    );
  });

  it("request_quote and issue_certificate proposals do not require bind disclosure", async () => {
    const stores = stubStores();
    const q = await proposeGovernedAction(
      WS,
      "request_quote",
      { subjectType: "quote", subjectId: "q_2" },
      { lineOfBusiness: "cyber" },
      "agent_1",
      stores,
    );
    assert.equal(q.kind, "insurance_request_quote");
    const c = await proposeGovernedAction(
      WS,
      "issue_certificate",
      { subjectType: "certificate", subjectId: "c_1" },
      { holderName: "Lessor LLC" },
      "agent_1",
      stores,
    );
    assert.equal(c.kind, "insurance_issue_certificate");
  });
});

describe("standing rules", () => {
  it("proposeStandingRule('bind_policy') throws — no auto-bind in v1", async () => {
    const stores = stubStores();
    await assert.rejects(
      () => proposeStandingRule(WS, "bind_policy", "gl", "owner_1", stores),
      (e) => e instanceof InsuranceError && e.code === "STANDING_RULE_REFUSED",
    );
  });

  it("proposeStandingRule('issue_certificate') throws — request_quote only", async () => {
    const stores = stubStores();
    await assert.rejects(
      () => proposeStandingRule(WS, "issue_certificate", "gl", "owner_1", stores),
      (e) => e instanceof InsuranceError && e.code === "STANDING_RULE_REFUSED",
    );
  });

  it("request_quote standing rule per line of business is allowed", async () => {
    const stores = stubStores();
    const rule = await proposeStandingRule(WS, "request_quote", "gl", "owner_1", stores);
    assert.equal(rule.lineOfBusiness, "gl");
    assert.equal(rule.approvedBy, "owner_1");
    assert.equal(await requestQuoteCovered(WS, "gl", stores), true);
    assert.equal(await requestQuoteCovered(WS, "cyber", stores), false);
  });

  it("rejects unknown lines of business", async () => {
    const stores = stubStores();
    await assert.rejects(
      () => proposeStandingRule(WS, "request_quote", "spaceship", "owner_1", stores),
      (e) => e instanceof InsuranceError && e.code === "BAD_LINE_OF_BUSINESS",
    );
  });
});

describe("decideGovernedAction", () => {
  it("approval writes a complete audit record (who/what/timestamp)", async () => {
    const stores = stubStores();
    const approval = await proposeGovernedAction(
      WS,
      "bind_policy",
      { subjectType: "quote", subjectId: "q_9" },
      BIND_DETAILS,
      "agent_1",
      stores,
    );
    const { approval: decided, audit } = await decideGovernedAction(
      approval.id,
      WS,
      "approve",
      "owner_1",
      "looks good",
      stores,
    );

    assert.equal(decided.status, "approved");
    assert.equal(audit.result, "approved");
    assert.equal(audit.action, "bind_policy");
    assert.equal(audit.subjectType, "quote");
    assert.equal(audit.subjectId, "q_9");
    assert.equal(audit.decidedBy, "owner_1");
    assert.ok(audit.decidedAt instanceof Date);
    // Payload snapshot carries what was approved (premium/limits/carrier/dates).
    const snap = audit.payload as Record<string, unknown>;
    assert.equal(snap["premiumCents"], 125000);
    assert.equal(snap["carrier"], "Acme Mutual");
    assert.equal(snap["effectiveDate"], "2026-11-01");
    // Vendor ref stays null until the licensed rail executes.
    assert.equal(audit.vendorTransactionRef, null);
    assert.equal(audit.note, "looks good");
  });

  it("deciding twice fails — only pending approvals are decidable", async () => {
    const stores = stubStores();
    const approval = await proposeGovernedAction(
      WS,
      "bind_policy",
      { subjectType: "quote", subjectId: "q_3" },
      BIND_DETAILS,
      "agent_1",
      stores,
    );
    await decideGovernedAction(approval.id, WS, "approve", "owner_1", undefined, stores);
    await assert.rejects(
      () => decideGovernedAction(approval.id, WS, "approve", "owner_1", undefined, stores),
      (e) => e instanceof InsuranceError && e.code === "APPROVAL_NOT_PENDING",
    );
    // One approval → exactly one audit record, never a duplicate.
    assert.equal(stores.audit.events.length, 1);
  });

  it("denied actions are recorded in the audit trail", async () => {
    const stores = stubStores();
    const approval = await proposeGovernedAction(
      WS,
      "issue_certificate",
      { subjectType: "certificate", subjectId: "c_7" },
      { holderName: "Lessor LLC" },
      "agent_1",
      stores,
    );
    const { approval: decided, audit } = await decideGovernedAction(
      approval.id,
      WS,
      "reject",
      "owner_1",
      "holder name unconfirmed",
      stores,
    );
    assert.equal(decided.status, "rejected");
    assert.equal(audit.result, "denied");
    assert.equal(audit.action, "issue_certificate");
    assert.equal(audit.subjectId, "c_7");
    assert.equal(audit.decidedBy, "owner_1");
    assert.equal(audit.note, "holder name unconfirmed");
  });

  it("refuses to decide another domain's approval (fail closed)", async () => {
    const stores = stubStores();
    const foreign = await stores.approvals.create({
      workspaceId: WS,
      kind: "sequence_send",
      payload: { action: "send" },
      requestedBy: "agent_1",
    });
    await assert.rejects(
      () => decideGovernedAction(foreign.id, WS, "approve", "owner_1", undefined, stores),
      (e) => e instanceof InsuranceError && e.code === "APPROVAL_KIND_MISMATCH",
    );
    assert.equal(stores.audit.events.length, 0);
  });

  it("unknown approval id fails", async () => {
    const stores = stubStores();
    await assert.rejects(
      () => decideGovernedAction("nope", WS, "approve", "owner_1", undefined, stores),
      (e) => e instanceof InsuranceError && e.code === "APPROVAL_NOT_FOUND",
    );
  });
});

describe("getPendingApprovals", () => {
  it("lists pending insurance approvals, filterable by action", async () => {
    const stores = stubStores();
    const b = await proposeGovernedAction(
      WS,
      "bind_policy",
      { subjectType: "quote", subjectId: "q_1" },
      BIND_DETAILS,
      "agent_1",
      stores,
    );
    await proposeGovernedAction(
      WS,
      "request_quote",
      { subjectType: "quote", subjectId: "q_2" },
      {},
      "agent_1",
      stores,
    );
    // A foreign-kind pending approval must never leak into the insurance queue.
    await stores.approvals.create({
      workspaceId: WS,
      kind: "sequence_send",
      payload: {},
      requestedBy: "agent_1",
    });

    const all = await getPendingApprovals(WS, undefined, stores);
    assert.equal(all.length, 2);

    const binds = await getPendingApprovals(WS, "bind_policy", stores);
    assert.equal(binds.length, 1);
    assert.equal(binds[0]!.id, b.id);

    // Decided items leave the pending list.
    await decideGovernedAction(b.id, WS, "approve", "owner_1", undefined, stores);
    const after = await getPendingApprovals(WS, undefined, stores);
    assert.equal(after.length, 1);
  });
});

describe("validateBindDisclosure", () => {
  it("accepts a complete disclosure", () => {
    validateBindDisclosure(BIND_DETAILS);
  });

  it("throws listing every missing field", () => {
    assert.throws(
      () => validateBindDisclosure({ carrier: "X" }),
      (e: unknown) =>
        e instanceof InsuranceError &&
        e.code === "BIND_DISCLOSURE_INCOMPLETE" &&
        /premiumCents/.test(e.message) &&
        /limitPerOccurrenceCents/.test(e.message) &&
        /effectiveDate/.test(e.message),
    );
  });
});

// Type-level: GovernedAction and GovernedSubjectType are the spec's vocab.
const _actions: GovernedAction[] = ["request_quote", "bind_policy", "issue_certificate"];
const _subjects: GovernedSubjectType[] = ["quote", "policy", "certificate"];
assert.ok(_actions.length === 3 && _subjects.length === 3);
