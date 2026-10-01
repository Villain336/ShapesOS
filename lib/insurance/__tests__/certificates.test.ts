// Marketr — Wave 2 Insurance slice 5 tests: COI (certificate of insurance) pipeline.
//
// Stub stores throughout: no database. Proves SPEC-INSURANCE.md §4.3, §5
// (the final Thread-1 slice):
// - prepare fails closed unless the policy is IN-FORCE (active) with at
//   least one verified limit;
// - missing coverage renders "not confirmed", never invented;
// - issuance requires an APPROVED issue_certificate approval whose payload
//   still matches the draft AND the live policy row (disclosure drift fails);
// - revoke writes an audit event with the reason;
// - the stored pdfHash matches the stored PDF bytes;
// - the holder audit trail records who requested, for which contract, who issued.
//
// Run: npx tsx --test lib/insurance/__tests__/certificates.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  assertPolicyInForce,
  assertPolicyLimitsVerified,
  buildCertificatePayload,
  issueCertificate,
  prepareCertificate,
  renderCertificatePdf,
  revokeCertificate,
  type CertificatePolicyTruth,
  type CertificateRecord,
  type CertificateStatus,
  type CertificateStore,
  type CertificateStores,
} from "../certificates";
import {
  type ApprovalRecord,
  type AuditEventRecord,
  type GovernedAction,
  type GovernedApprovalStore,
  type GovernedSubjectType,
  type GovernanceStores,
  type InsuranceAuditStore,
} from "../governance";
import { InsuranceError } from "../types";

const WS = "ws_test";

function policy(over: Partial<CertificatePolicyTruth> = {}): CertificatePolicyTruth {
  return {
    id: "pol_1",
    policyNumber: "GL-2026-001",
    line: "gl",
    carrierName: "AmTrust",
    namedInsured: "Acme Landscaping LLC",
    effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    limitPerOccurrenceCents: 100_000_000,
    limitAggregateCents: 200_000_000,
    deductibleCents: 250_000,
    status: "active",
    ...over,
  };
}

interface StubStores extends CertificateStores {
  certificates: CertificateStore & {
    policies: Map<string, CertificatePolicyTruth>;
    certs: Map<string, CertificateRecord>;
    pdfs: Map<string, Buffer>;
  };
  governance: GovernanceStores & {
    approvals: GovernedApprovalStore & { items: Map<string, ApprovalRecord> };
    audit: InsuranceAuditStore & { events: AuditEventRecord[] };
  };
}

function stubStores(): StubStores {
  const policies = new Map<string, CertificatePolicyTruth>();
  const certs = new Map<string, CertificateRecord>();
  const pdfs = new Map<string, Buffer>();
  let seq = 0;
  let apprSeq = 0;
  let auditSeq = 0;
  const items = new Map<string, ApprovalRecord>();
  const events: AuditEventRecord[] = [];

  const certificates: StubStores["certificates"] = {
    policies,
    certs,
    pdfs,
    async findPolicy(policyId, workspaceId) {
      void workspaceId;
      return policies.get(policyId) ?? null;
    },
    async create(input) {
      const id = `cert_${++seq}`;
      const rec: CertificateRecord = {
        id,
        workspaceId: input.workspaceId,
        policyId: input.policyId,
        holderName: input.holderName,
        holderAddress: input.holderAddress,
        additionalInsured: input.additionalInsured,
        waiverOfSubrogation: input.waiverOfSubrogation,
        operationsDescription: input.operationsDescription,
        issueDate: input.issueDate,
        validFrom: input.validFrom,
        validTo: input.validTo,
        status: "draft",
        requestedBy: input.requestedBy,
        requestedFor: input.requestedFor,
        issuedBy: null,
        issuedAt: null,
        approvalId: input.approvalId,
        pdfHash: null,
        revokedReason: null,
        revokedAt: null,
        revokedBy: null,
      };
      certs.set(id, rec);
      return rec;
    },
    async get(id, workspaceId) {
      const rec = certs.get(id);
      return rec && rec.workspaceId === workspaceId ? rec : null;
    },
    async update(id, workspaceId, patch) {
      const rec = certs.get(id);
      if (!rec || rec.workspaceId !== workspaceId) throw new Error("not found");
      const { pdfBytes, ...rest } = patch;
      if (pdfBytes !== undefined) pdfs.set(id, pdfBytes);
      const next: CertificateRecord = { ...rec, ...rest, status: (rest.status ?? rec.status) as CertificateStatus };
      certs.set(id, next);
      return next;
    },
    async list(workspaceId) {
      return [...certs.values()].filter((c) => c.workspaceId === workspaceId);
    },
  };

  const approvals: StubStores["governance"]["approvals"] = {
    items,
    async create(input) {
      const id = `appr_${++apprSeq}`;
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
        (a) => a.workspaceId === workspaceId && a.status === "pending" && kinds.includes(a.kind),
      );
    },
  };

  const audit: StubStores["governance"]["audit"] = {
    events,
    async create(input) {
      const rec: AuditEventRecord = {
        id: `audit_${++auditSeq}`,
        workspaceId: input.workspaceId,
        action: input.action as GovernedAction,
        subjectType: input.subjectType as GovernedSubjectType,
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

  return {
    certificates,
    governance: {
      approvals,
      audit,
      quoteRules: {
        async find() {
          return null;
        },
        async upsert(workspaceId, lineOfBusiness, approvedBy) {
          return {
            id: "qr",
            workspaceId,
            lineOfBusiness,
            approvedBy: approvedBy ?? null,
            createdAt: new Date(),
          };
        },
        async list() {
          return [];
        },
      },
    },
  };
}

async function prepared(stores: StubStores, holder: Record<string, unknown> = {}) {
  stores.certificates.policies.set("pol_1", policy());
  return prepareCertificate(WS, {
    policyId: "pol_1",
    holderName: "City of Greensboro",
    holderAddress: "300 W Washington St, Greensboro, NC 27401",
    additionalInsured: true,
    waiverOfSubrogation: false,
    operationsDescription: "Landscaping services per contract 2026-118",
    requestedBy: "agent-1",
    requestedFor: "Contract 2026-118 with the City of Greensboro",
    ...holder,
  }, stores);
}

async function approvedIssued(stores: StubStores, issuedBy = "tico") {
  const { certificate, approval } = await prepared(stores);
  await stores.governance.approvals.decide(approval.id, WS, "approve", "tico", undefined);
  return issueCertificate(WS, certificate.id, approval.id, issuedBy, stores);
}

describe("prepareCertificate — fail closed on policy truth", () => {
  it("prepares a draft from an in-force policy and proposes the governed action", async () => {
    const stores = stubStores();
    const { certificate, approval, payload } = await prepared(stores);
    assert.equal(certificate.status, "draft");
    assert.equal(approval.kind, "insurance_issue_certificate");
    assert.equal(certificate.approvalId, approval.id);
    assert.equal(payload.carrier, "AmTrust");
    assert.equal(payload.policyNumber, "GL-2026-001");
    assert.equal(payload.holderName, "City of Greensboro");
  });

  it("fails CERT_POLICY_NOT_INFORCE for an expired policy", async () => {
    const stores = stubStores();
    stores.certificates.policies.set("pol_1", policy({ status: "expired" }));
    await assert.rejects(
      () => prepareCertificate(WS, { policyId: "pol_1", holderName: "Holder" }, stores),
      (e) => e instanceof InsuranceError && e.code === "CERT_POLICY_NOT_INFORCE",
    );
    assert.equal(stores.certificates.certs.size, 0, "no draft created");
    assert.equal(stores.governance.approvals.items.size, 0, "no approval proposed");
  });

  it("fails CERT_POLICY_NOT_INFORCE for a cancelled policy", async () => {
    const stores = stubStores();
    stores.certificates.policies.set("pol_1", policy({ status: "cancelled" }));
    await assert.rejects(
      () => prepareCertificate(WS, { policyId: "pol_1", holderName: "Holder" }, stores),
      (e) => e instanceof InsuranceError && e.code === "CERT_POLICY_NOT_INFORCE",
    );
  });

  it("fails CERT_POLICY_NOT_INFORCE for a pending-renewal policy", async () => {
    const stores = stubStores();
    stores.certificates.policies.set("pol_1", policy({ status: "pending_renewal" }));
    await assert.rejects(
      () => prepareCertificate(WS, { policyId: "pol_1", holderName: "Holder" }, stores),
      (e) => e instanceof InsuranceError && e.code === "CERT_POLICY_NOT_INFORCE",
    );
  });

  it("fails CERT_POLICY_LIMITS_UNVERIFIED when the policy has no verified limits", async () => {
    const stores = stubStores();
    stores.certificates.policies.set(
      "pol_1",
      policy({ limitPerOccurrenceCents: null, limitAggregateCents: null }),
    );
    await assert.rejects(
      () => prepareCertificate(WS, { policyId: "pol_1", holderName: "Holder" }, stores),
      (e) => e instanceof InsuranceError && e.code === "CERT_POLICY_LIMITS_UNVERIFIED",
    );
  });

  it("fails CERT_HOLDER_REQUIRED when the holder name is blank", async () => {
    const stores = stubStores();
    stores.certificates.policies.set("pol_1", policy());
    await assert.rejects(
      () => prepareCertificate(WS, { policyId: "pol_1", holderName: "  " }, stores),
      (e) => e instanceof InsuranceError && e.code === "CERT_HOLDER_REQUIRED",
    );
  });

  it("clamps the validity window into the policy term", async () => {
    const stores = stubStores();
    stores.certificates.policies.set("pol_1", policy());
    const { certificate } = await prepareCertificate(
      WS,
      {
        policyId: "pol_1",
        holderName: "Holder",
        validTo: new Date("2030-06-01T00:00:00.000Z"),
      },
      stores,
    );
    assert.equal(certificate.validTo.toISOString(), "2027-01-01T00:00:00.000Z");
  });

  it("assertPolicyInForce / assertPolicyLimitsVerified are pure and fail closed", () => {
    assert.throws(
      () => assertPolicyInForce(policy({ status: "expired" })),
      (e) => e instanceof InsuranceError && e.code === "CERT_POLICY_NOT_INFORCE",
    );
    assert.throws(
      () => assertPolicyLimitsVerified(policy({ limitPerOccurrenceCents: null, limitAggregateCents: null })),
      (e) => e instanceof InsuranceError && e.code === "CERT_POLICY_LIMITS_UNVERIFIED",
    );
    // One verified limit is enough.
    assertPolicyLimitsVerified(policy({ limitAggregateCents: null }));
  });
});

describe("issueCertificate — approved approval, re-verified disclosure", () => {
  it("issues only after an approved approval, storing bytes + hash", async () => {
    const stores = stubStores();
    const { certificate, approval } = await prepared(stores);
    await stores.governance.approvals.decide(approval.id, WS, "approve", "tico", undefined);
    const { certificate: issued, pdfBytes, pdfHash } = await issueCertificate(
      WS,
      certificate.id,
      approval.id,
      "tico",
      stores,
    );
    assert.equal(issued.status, "issued");
    assert.equal(issued.issuedBy, "tico");
    assert.ok(issued.issuedAt instanceof Date);
    assert.ok(pdfBytes.length > 0);
    assert.equal(pdfHash, createHash("sha256").update(pdfBytes).digest("hex"));
    assert.equal(issued.pdfHash, pdfHash);
    assert.equal(stores.certificates.pdfs.get(certificate.id), pdfBytes);
  });

  it("fails CERT_APPROVAL_NOT_APPROVED when the approval is still pending", async () => {
    const stores = stubStores();
    const { certificate, approval } = await prepared(stores);
    await assert.rejects(
      () => issueCertificate(WS, certificate.id, approval.id, "tico", stores),
      (e) => e instanceof InsuranceError && e.code === "CERT_APPROVAL_NOT_APPROVED",
    );
  });

  it("fails CERT_APPROVAL_NOT_APPROVED when the approval was rejected", async () => {
    const stores = stubStores();
    const { certificate, approval } = await prepared(stores);
    await stores.governance.approvals.decide(approval.id, WS, "reject", "tico", "bad terms");
    await assert.rejects(
      () => issueCertificate(WS, certificate.id, approval.id, "tico", stores),
      (e) => e instanceof InsuranceError && e.code === "CERT_APPROVAL_NOT_APPROVED",
    );
  });

  it("fails CERT_DISCLOSURE_MISMATCH when the draft drifted after approval", async () => {
    const stores = stubStores();
    const { certificate, approval } = await prepared(stores);
    await stores.governance.approvals.decide(approval.id, WS, "approve", "tico", undefined);
    // Tamper with the draft after approval (simulates an edited row).
    await stores.certificates.update(certificate.id, WS, { holderName: "Sneaky LLC" });
    await assert.rejects(
      () => issueCertificate(WS, certificate.id, approval.id, "tico", stores),
      (e) => e instanceof InsuranceError && e.code === "CERT_DISCLOSURE_MISMATCH",
    );
  });

  it("fails when the policy lapsed between prepare and issue (re-verified)", async () => {
    const stores = stubStores();
    const { certificate, approval } = await prepared(stores);
    await stores.governance.approvals.decide(approval.id, WS, "approve", "tico", undefined);
    stores.certificates.policies.set("pol_1", policy({ status: "expired" }));
    await assert.rejects(
      () => issueCertificate(WS, certificate.id, approval.id, "tico", stores),
      (e) => e instanceof InsuranceError && e.code === "CERT_POLICY_NOT_INFORCE",
    );
  });

  it("fails CERT_INVALID_CERT_STATUS when issuing twice", async () => {
    const stores = stubStores();
    const { certificate, approval } = await prepared(stores);
    await stores.governance.approvals.decide(approval.id, WS, "approve", "tico", undefined);
    await issueCertificate(WS, certificate.id, approval.id, "tico", stores);
    await assert.rejects(
      () => issueCertificate(WS, certificate.id, approval.id, "tico", stores),
      (e) => e instanceof InsuranceError && e.code === "CERT_INVALID_CERT_STATUS",
    );
  });
});

describe("revokeCertificate", () => {
  it("revokes an issued certificate with reason + audit event", async () => {
    const stores = stubStores();
    const { certificate } = await approvedIssued(stores);
    const auditsBefore = stores.governance.audit.events.length;
    const revoked = await revokeCertificate(WS, certificate.id, "tico", "Policy cancelled mid-term", stores);
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revokedReason, "Policy cancelled mid-term");
    assert.equal(revoked.revokedBy, "tico");
    assert.ok(revoked.revokedAt instanceof Date);
    const audit = stores.governance.audit.events[stores.governance.audit.events.length - 1]!;
    assert.equal(stores.governance.audit.events.length, auditsBefore + 1);
    assert.equal(audit.action, "issue_certificate");
    assert.equal(audit.subjectType, "certificate");
    assert.equal(audit.subjectId, certificate.id);
    assert.equal(audit.decidedBy, "tico");
    assert.match(audit.note ?? "", /revoked/i);
    assert.match(audit.note ?? "", /Policy cancelled mid-term/);
  });

  it("fails CERT_INVALID_CERT_STATUS when revoking a draft", async () => {
    const stores = stubStores();
    const { certificate } = await prepared(stores);
    await assert.rejects(
      () => revokeCertificate(WS, certificate.id, "tico", "reason", stores),
      (e) => e instanceof InsuranceError && e.code === "CERT_INVALID_CERT_STATUS",
    );
  });

  it("fails CERT_REVOKE_REASON_REQUIRED without a reason", async () => {
    const stores = stubStores();
    const { certificate } = await approvedIssued(stores);
    await assert.rejects(
      () => revokeCertificate(WS, certificate.id, "tico", "  ", stores),
      (e) => e instanceof InsuranceError && e.code === "CERT_REVOKE_REASON_REQUIRED",
    );
  });
});

describe("PDF: renders policy truth, never invents", () => {
  it("starts with the PDF header and contains the policy truth fields", async () => {
    const stores = stubStores();
    const { pdfBytes } = await approvedIssued(stores);
    const text = pdfBytes.toString("latin1");
    assert.ok(text.startsWith("%PDF-1.4"), "minimal PDF header");
    assert.ok(text.includes("CERTIFICATE OF LIABILITY INSURANCE"));
    assert.ok(text.includes("GL-2026-001"), "policy number from truth");
    assert.ok(text.includes("AmTrust"), "carrier from truth");
    assert.ok(text.includes("City of Greensboro"), "holder from reviewed input");
    assert.ok(text.includes("Additional insured"), "endorsement section");
    assert.ok(text.includes("xref"), "valid xref table");
    assert.ok(text.trimEnd().endsWith("%%EOF"), "valid trailer");
  });

  it("renders a missing limit as 'not confirmed', never a guess", async () => {
    const stores = stubStores();
    stores.certificates.policies.set(
      "pol_1",
      policy({ limitAggregateCents: null, deductibleCents: null }),
    );
    const { certificate, approval } = await prepareCertificate(
      WS,
      { policyId: "pol_1", holderName: "Holder" },
      stores,
    );
    await stores.governance.approvals.decide(approval.id, WS, "approve", "tico", undefined);
    const { pdfBytes } = await issueCertificate(WS, certificate.id, approval.id, "tico", stores);
    const text = pdfBytes.toString("latin1");
    assert.ok(text.includes("not confirmed"), "unverified fields read not confirmed");
    assert.ok(text.includes("$1,000,000"), "the verified per-occurrence limit still renders");
    assert.ok(!text.includes("$2,000,000"), "no aggregate limit invented");
  });

  it("pdfHash matches the stored bytes (evidence binding)", async () => {
    const stores = stubStores();
    const { certificate, pdfBytes, pdfHash } = await approvedIssued(stores);
    const stored = stores.certificates.pdfs.get(certificate.id)!;
    assert.equal(stored, pdfBytes);
    assert.equal(createHash("sha256").update(stored).digest("hex"), pdfHash);
    assert.equal(createHash("sha256").update(stored).digest("hex"), certificate.pdfHash);
  });

  it("renderCertificatePdf is deterministic for the same payload", () => {
    const stores = stubStores();
    const p = policy();
    const payload = buildCertificatePayload(
      "cert_1",
      p,
      {
        holderName: "Holder",
        holderAddress: null,
        additionalInsured: false,
        waiverOfSubrogation: false,
        operationsDescription: null,
        requestedBy: null,
        requestedFor: null,
      },
      { issueDate: new Date("2026-10-01T00:00:00.000Z"), validFrom: new Date("2026-10-01T00:00:00.000Z"), validTo: new Date("2027-01-01T00:00:00.000Z") },
    );
    void stores;
    const a = renderCertificatePdf(payload);
    const b = renderCertificatePdf(payload);
    assert.deepEqual(a, b);
  });
});

describe("holder audit trail", () => {
  it("the issue audit records who requested, for which contract, who issued", async () => {
    const stores = stubStores();
    const { certificate } = await approvedIssued(stores, "tico");
    const issueAudit = stores.governance.audit.events.find(
      (a) => a.subjectId === certificate.id && (a.note ?? "").includes("issued to holder"),
    );
    assert.ok(issueAudit, "issue audit event written");
    assert.equal(issueAudit!.decidedBy, "tico");
    assert.match(issueAudit!.note ?? "", /City of Greensboro/);
    assert.match(issueAudit!.note ?? "", /Contract 2026-118/);
    assert.match(issueAudit!.note ?? "", /requested by agent-1/);
    assert.equal(issueAudit!.action, "issue_certificate");
    assert.ok(issueAudit!.decidedAt instanceof Date);
    const payload = issueAudit!.payload as Record<string, unknown>;
    assert.equal(payload.holderName, "City of Greensboro");
    assert.equal(payload.carrier, "AmTrust");
  });

  it("records issuedAt on the certificate row itself", async () => {
    const stores = stubStores();
    const { certificate } = await approvedIssued(stores);
    assert.ok(certificate.issuedAt instanceof Date);
    assert.equal(certificate.issuedBy, "tico");
  });
});
