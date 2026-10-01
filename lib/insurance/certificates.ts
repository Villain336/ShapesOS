// Marketr — Wave 2 Insurance slice 5 (final Thread-1 slice): the COI
// (certificate of insurance) pipeline.
//
// SPEC-INSURANCE.md §4.1, §4.3, §5. Tico's decisions for this domain:
// - Money red-lane; no invented coverage — every certificate field renders
//   from the in-force Policy row, anything missing reads "not confirmed".
// - The agent prepares, the human reviews, the rail/system issues: prepare
//   creates a draft + proposes the issue_certificate governed action;
//   issuance requires an APPROVED approval whose payload still matches the
//   draft (re-verified at issue time — disclosure drift fails closed).
// - Certificates render from policy truth, never from drafts or quotes.
//
// Persistence-agnostic like governance.ts / renewals.ts: pure rules plus
// store ports (Prisma default, stubs in tests).

import { createHash } from "node:crypto";
import { InsuranceError, LINE_LABELS } from "./types";
import {
  approvalKindForAction,
  proposeGovernedAction,
  type ApprovalRecord,
  type GovernedActionDetails,
  type GovernanceStores,
  prismaGovernanceStores,
} from "./governance";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Domain.
// ---------------------------------------------------------------------------

/** "In-force" in this repo's policy vocabulary = status "active". */
export const POLICY_INFORCE_STATUS = "active" as const;

export type CertificateStatus = "draft" | "issued" | "revoked";

/** The policy truth a certificate may be issued from. */
export interface CertificatePolicyTruth {
  id: string;
  policyNumber: string;
  line: string;
  carrierName: string;
  namedInsured: string;
  effectiveAt: Date;
  expiresAt: Date;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  deductibleCents: number | null;
  status: string;
}

export interface CertificateRecord {
  id: string;
  workspaceId: string;
  policyId: string;
  holderName: string;
  holderAddress: string | null;
  additionalInsured: boolean;
  waiverOfSubrogation: boolean;
  operationsDescription: string | null;
  issueDate: Date;
  validFrom: Date;
  validTo: Date;
  status: CertificateStatus;
  requestedBy: string | null;
  requestedFor: string | null;
  issuedBy: string | null;
  issuedAt: Date | null;
  approvalId: string | null;
  pdfHash: string | null;
  revokedReason: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}

export interface PrepareCertificateInput {
  policyId: string;
  holderName: string;
  holderAddress?: string | null;
  additionalInsured?: boolean;
  waiverOfSubrogation?: boolean;
  operationsDescription?: string | null;
  requestedBy?: string;
  requestedFor?: string;
  /** Defaults to now (clamped into the policy term). */
  issueDate?: Date;
  /** Defaults to the issue date. */
  validFrom?: Date;
  /** Defaults to the policy expiry — a COI never outlives its policy. */
  validTo?: Date;
}

/**
 * The verified payload carried on the approval and rendered into the PDF.
 * Every field comes from the policy row or the (human-reviewable) holder
 * input — nothing is invented. Null coverage fields render "not confirmed".
 */
export interface CertificatePayload {
  certificateId: string;
  policyId: string;
  policyNumber: string;
  lineOfBusiness: string;
  lineLabel: string;
  carrier: string;
  namedInsured: string;
  holderName: string;
  holderAddress: string | null;
  additionalInsured: boolean;
  waiverOfSubrogation: boolean;
  operationsDescription: string | null;
  issueDate: string;
  validFrom: string;
  validTo: string;
  effectiveDate: string;
  expiryDate: string;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  deductibleCents: number | null;
  requestedBy: string | null;
  requestedFor: string | null;
}

// ---------------------------------------------------------------------------
// Store ports.
// ---------------------------------------------------------------------------

export interface CertificateStore {
  findPolicy(policyId: string, workspaceId: string): Promise<CertificatePolicyTruth | null>;
  create(input: {
    workspaceId: string;
    policyId: string;
    holderName: string;
    holderAddress: string | null;
    additionalInsured: boolean;
    waiverOfSubrogation: boolean;
    operationsDescription: string | null;
    issueDate: Date;
    validFrom: Date;
    validTo: Date;
    requestedBy: string | null;
    requestedFor: string | null;
    approvalId: string | null;
  }): Promise<CertificateRecord>;
  get(id: string, workspaceId: string): Promise<CertificateRecord | null>;
  update(
    id: string,
    workspaceId: string,
    patch: Partial<CertificateRecord> & { pdfBytes?: Buffer },
  ): Promise<CertificateRecord>;
  list(workspaceId: string): Promise<CertificateRecord[]>;
}

export interface CertificateStores {
  certificates: CertificateStore;
  governance: GovernanceStores;
}

function toPolicyTruth(row: {
  id: string;
  policyNumber: string;
  line: string;
  carrier: { name: string };
  namedInsured: string;
  effectiveAt: Date;
  expiresAt: Date;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  deductibleCents: number | null;
  status: string;
}): CertificatePolicyTruth {
  return {
    id: row.id,
    policyNumber: row.policyNumber,
    line: row.line,
    carrierName: row.carrier.name,
    namedInsured: row.namedInsured,
    effectiveAt: row.effectiveAt,
    expiresAt: row.expiresAt,
    limitPerOccurrenceCents: row.limitPerOccurrenceCents,
    limitAggregateCents: row.limitAggregateCents,
    deductibleCents: row.deductibleCents,
    status: row.status,
  };
}

function toCertificateRecord(row: {
  id: string;
  workspaceId: string;
  policyId: string;
  holderName: string;
  holderAddress: string | null;
  additionalInsured: boolean;
  waiverOfSubrogation: boolean;
  operationsDescription: string | null;
  issueDate: Date;
  validFrom: Date;
  validTo: Date;
  status: string;
  requestedBy: string | null;
  requestedFor: string | null;
  issuedBy: string | null;
  issuedAt: Date | null;
  approvalId: string | null;
  pdfHash: string | null;
  revokedReason: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}): CertificateRecord {
  return {
    ...row,
    status: row.status as CertificateStatus,
  };
}

export function prismaCertificateStore(): CertificateStore {
  return {
    async findPolicy(policyId, workspaceId) {
      const row = await prisma.insurancePolicy.findFirst({
        where: { id: policyId, workspaceId },
        include: { carrier: { select: { name: true } } },
      });
      return row ? toPolicyTruth(row) : null;
    },
    async create(input) {
      const row = await prisma.insuranceCertificate.create({ data: input });
      return toCertificateRecord(row);
    },
    async get(id, workspaceId) {
      const row = await prisma.insuranceCertificate.findFirst({
        where: { id, workspaceId },
      });
      return row ? toCertificateRecord(row) : null;
    },
    async update(id, workspaceId, patch) {
      const row = await prisma.insuranceCertificate.update({
        where: { id, workspaceId },
        data: {
          holderName: patch.holderName,
          holderAddress: patch.holderAddress,
          additionalInsured: patch.additionalInsured,
          waiverOfSubrogation: patch.waiverOfSubrogation,
          operationsDescription: patch.operationsDescription,
          issueDate: patch.issueDate,
          validFrom: patch.validFrom,
          validTo: patch.validTo,
          status: patch.status,
          issuedBy: patch.issuedBy,
          issuedAt: patch.issuedAt,
          approvalId: patch.approvalId,
          // Buffer is a Uint8Array at runtime; the generated update input
          // wants Uint8Array<ArrayBuffer> explicitly.
          pdfBytes: patch.pdfBytes as unknown as Uint8Array<ArrayBuffer> | undefined,
          pdfHash: patch.pdfHash,
          revokedReason: patch.revokedReason,
          revokedAt: patch.revokedAt,
          revokedBy: patch.revokedBy,
        },
      });
      return toCertificateRecord(row);
    },
    async list(workspaceId) {
      const rows = await prisma.insuranceCertificate.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toCertificateRecord);
    },
  };
}

export function prismaCertificateStores(): CertificateStores {
  return {
    certificates: prismaCertificateStore(),
    governance: prismaGovernanceStores(),
  };
}

// ---------------------------------------------------------------------------
// Prepare: the agent prepares a draft from POLICY TRUTH ONLY.
// ---------------------------------------------------------------------------

/** Fail closed: a policy is COI-eligible only when in-force. */
export function assertPolicyInForce(policy: CertificatePolicyTruth): void {
  if (policy.status !== POLICY_INFORCE_STATUS) {
    throw new InsuranceError(
      "CERT_POLICY_NOT_INFORCE",
      `Certificates may only be issued from in-force policies. ` +
        `Policy ${policy.policyNumber} is ${policy.status}.`,
    );
  }
}

/**
 * Fail closed on verified limits: at least one limit (per-occurrence or
 * aggregate) must be confirmed on the policy. Anything missing renders
 * "not confirmed" on the certificate — never invented.
 */
export function assertPolicyLimitsVerified(policy: CertificatePolicyTruth): void {
  if (policy.limitPerOccurrenceCents == null && policy.limitAggregateCents == null) {
    throw new InsuranceError(
      "CERT_POLICY_LIMITS_UNVERIFIED",
      `Policy ${policy.policyNumber} has no verified limits — a certificate ` +
        `cannot be issued until at least one limit is confirmed.`,
    );
  }
}

/**
 * Build the verified certificate payload from policy truth + holder input.
 * The validity window is clamped into the policy term — a COI never
 * outlives its issuing policy.
 */
export function buildCertificatePayload(
  certificateId: string,
  policy: CertificatePolicyTruth,
  holder: {
    holderName: string;
    holderAddress: string | null;
    additionalInsured: boolean;
    waiverOfSubrogation: boolean;
    operationsDescription: string | null;
    requestedBy: string | null;
    requestedFor: string | null;
  },
  dates: { issueDate: Date; validFrom: Date; validTo: Date },
): CertificatePayload {
  return {
    certificateId,
    policyId: policy.id,
    policyNumber: policy.policyNumber,
    lineOfBusiness: policy.line,
    lineLabel: LINE_LABELS[policy.line as keyof typeof LINE_LABELS] ?? policy.line,
    carrier: policy.carrierName,
    namedInsured: policy.namedInsured,
    holderName: holder.holderName,
    holderAddress: holder.holderAddress,
    additionalInsured: holder.additionalInsured,
    waiverOfSubrogation: holder.waiverOfSubrogation,
    operationsDescription: holder.operationsDescription,
    issueDate: dates.issueDate.toISOString(),
    validFrom: dates.validFrom.toISOString(),
    validTo: dates.validTo.toISOString(),
    effectiveDate: policy.effectiveAt.toISOString(),
    expiryDate: policy.expiresAt.toISOString(),
    limitPerOccurrenceCents: policy.limitPerOccurrenceCents,
    limitAggregateCents: policy.limitAggregateCents,
    deductibleCents: policy.deductibleCents,
    requestedBy: holder.requestedBy,
    requestedFor: holder.requestedFor,
  };
}

/** Holder input validation: the human must see real holder details to review. */
export function validateHolderInput(input: PrepareCertificateInput): void {
  if (!input.policyId || input.policyId.trim().length === 0) {
    throw new InsuranceError("CERT_POLICY_REQUIRED", "A certificate must reference an issuing policy.");
  }
  if (!input.holderName || input.holderName.trim().length === 0) {
    throw new InsuranceError(
      "CERT_HOLDER_REQUIRED",
      "A certificate holder name is required — the holder is the reviewed party on the approval.",
    );
  }
  if (input.holderName.trim().length > 200) {
    throw new InsuranceError("CERT_HOLDER_TOO_LONG", "Certificate holder name is too long (max 200).");
  }
  if (input.holderAddress && input.holderAddress.trim().length > 500) {
    throw new InsuranceError("CERT_HOLDER_ADDRESS_TOO_LONG", "Certificate holder address is too long (max 500).");
  }
  if (input.operationsDescription && input.operationsDescription.trim().length > 2000) {
    throw new InsuranceError("CERT_OPERATIONS_TOO_LONG", "Operations description is too long (max 2000).");
  }
}

/**
 * Prepare a certificate: the agent prepares, the human reviews.
 *
 * Loads the policy, fails closed unless it is in-force with verified
 * limits, builds the payload from POLICY TRUTH ONLY, creates the draft,
 * and proposes the issue_certificate governed action with the full
 * payload for human review. Returns the draft + the proposed approval.
 */
export async function prepareCertificate(
  workspaceId: string,
  input: PrepareCertificateInput,
  stores: CertificateStores = prismaCertificateStores(),
): Promise<{ certificate: CertificateRecord; approval: ApprovalRecord; payload: CertificatePayload }> {
  validateHolderInput(input);
  const policy = await stores.certificates.findPolicy(input.policyId, workspaceId);
  if (!policy) {
    throw new InsuranceError("CERT_POLICY_NOT_FOUND", "Issuing policy not found in this workspace.");
  }
  assertPolicyInForce(policy);
  assertPolicyLimitsVerified(policy);

  const issueDate = input.issueDate ?? new Date();
  // A COI never outlives its policy: clamp the validity window into the
  // policy term. Default validity = issue date → policy expiry.
  const clamp = (d: Date): Date =>
    d < policy.effectiveAt ? policy.effectiveAt : d > policy.expiresAt ? policy.expiresAt : d;
  const validFrom = clamp(input.validFrom ?? issueDate);
  const validTo = clamp(input.validTo ?? policy.expiresAt);
  if (validTo <= validFrom) {
    throw new InsuranceError(
      "CERT_INVALID_VALIDITY",
      "The certificate validity window must lie inside the policy term with validTo after validFrom.",
    );
  }

  const holder = {
    holderName: input.holderName.trim(),
    holderAddress: input.holderAddress?.trim() || null,
    additionalInsured: input.additionalInsured === true,
    waiverOfSubrogation: input.waiverOfSubrogation === true,
    operationsDescription: input.operationsDescription?.trim() || null,
    requestedBy: input.requestedBy?.trim() || null,
    requestedFor: input.requestedFor?.trim() || null,
  };

  // Create the draft first so the approval payload can name it as subject.
  const draft = await stores.certificates.create({
    workspaceId,
    policyId: policy.id,
    holderName: holder.holderName,
    holderAddress: holder.holderAddress,
    additionalInsured: holder.additionalInsured,
    waiverOfSubrogation: holder.waiverOfSubrogation,
    operationsDescription: holder.operationsDescription,
    issueDate,
    validFrom,
    validTo,
    requestedBy: holder.requestedBy,
    requestedFor: holder.requestedFor,
    approvalId: null,
  });

  const payload = buildCertificatePayload(draft.id, policy, holder, { issueDate, validFrom, validTo });

  const details: GovernedActionDetails = {
    ...payload,
    carrier: payload.carrier,
    limitPerOccurrenceCents: payload.limitPerOccurrenceCents,
    limitAggregateCents: payload.limitAggregateCents,
    effectiveDate: payload.effectiveDate,
    expiryDate: payload.expiryDate,
    lineOfBusiness: payload.lineOfBusiness,
    holderName: payload.holderName,
  };
  const approval = await proposeGovernedAction(
    workspaceId,
    "issue_certificate",
    { subjectType: "certificate", subjectId: draft.id },
    details,
    holder.requestedBy ?? undefined,
    stores.governance,
  );

  const certificate = await stores.certificates.update(draft.id, workspaceId, {
    approvalId: approval.id,
  });
  return { certificate, approval, payload };
}

// ---------------------------------------------------------------------------
// Issue: the system issues after explicit human approval — re-verified.
// ---------------------------------------------------------------------------

/** The approval's certificate payload, re-extracted at issue time. */
function certificateFieldsFromApprovalPayload(payload: unknown): Record<string, unknown> {
  const p = (payload ?? {}) as Record<string, unknown>;
  return {
    policyId: p["policyId"],
    holderName: p["holderName"],
    holderAddress: p["holderAddress"],
    additionalInsured: p["additionalInsured"],
    waiverOfSubrogation: p["waiverOfSubrogation"],
    operationsDescription: p["operationsDescription"],
    validFrom: p["validFrom"],
    validTo: p["validTo"],
    issueDate: p["issueDate"],
  };
}

/**
 * Re-verify the approval payload against the draft AND the live policy row.
 * Any drift — edited draft, changed holder input, or policy truth moving
 * (limits, carrier, term, status) since prepare — fails closed.
 */
export function assertApprovalMatchesCertificate(
  certificate: CertificateRecord,
  policy: CertificatePolicyTruth,
  approval: ApprovalRecord,
): void {
  if (approval.kind !== approvalKindForAction("issue_certificate")) {
    throw new InsuranceError(
      "CERT_APPROVAL_KIND_MISMATCH",
      "This approval is not an issue_certificate governed action.",
    );
  }
  if (approval.status !== "approved") {
    throw new InsuranceError(
      "CERT_APPROVAL_NOT_APPROVED",
      `The issue_certificate approval is ${approval.status} — only an approved approval may issue a certificate.`,
    );
  }
  const approved = certificateFieldsFromApprovalPayload(approval.payload);
  const draft: Record<string, unknown> = {
    policyId: certificate.policyId,
    holderName: certificate.holderName,
    holderAddress: certificate.holderAddress,
    additionalInsured: certificate.additionalInsured,
    waiverOfSubrogation: certificate.waiverOfSubrogation,
    operationsDescription: certificate.operationsDescription,
    validFrom: certificate.validFrom.toISOString(),
    validTo: certificate.validTo.toISOString(),
    issueDate: certificate.issueDate.toISOString(),
  };
  for (const [key, value] of Object.entries(draft)) {
    if (approved[key] !== value) {
      throw new InsuranceError(
        "CERT_DISCLOSURE_MISMATCH",
        `The draft certificate drifted from the approved disclosure (${key} changed). ` +
          `Re-prepare the certificate for a fresh human review.`,
      );
    }
  }
  // The policy truth itself may have moved since prepare — re-verify.
  assertPolicyInForce(policy);
  assertPolicyLimitsVerified(policy);
  if (policy.id !== certificate.policyId) {
    throw new InsuranceError(
      "CERT_POLICY_CHANGED",
      "The issuing policy changed since the approval. Re-prepare the certificate.",
    );
  }
}

/**
 * Issue the certificate: requires an APPROVED issue_certificate approval
 * whose payload still matches the draft (re-verified, drift fails closed).
 * Generates the ACORD-25-style PDF from the verified payload, stores the
 * bytes + sha256 hash, marks the certificate issued, and writes the audit
 * record with issuedAt plus the holder audit trail (who requested, for
 * which contract, who issued).
 */
export async function issueCertificate(
  workspaceId: string,
  certificateId: string,
  approvalId: string,
  issuedBy: string,
  stores: CertificateStores = prismaCertificateStores(),
): Promise<{ certificate: CertificateRecord; pdfBytes: Buffer; pdfHash: string }> {
  const certificate = await stores.certificates.get(certificateId, workspaceId);
  if (!certificate) {
    throw new InsuranceError("CERT_NOT_FOUND", "Certificate not found in this workspace.");
  }
  if (certificate.status !== "draft") {
    throw new InsuranceError(
      "CERT_INVALID_CERT_STATUS",
      `Only draft certificates can be issued. This one is ${certificate.status}.`,
    );
  }
  if (!approvalId || approvalId.trim().length === 0) {
    throw new InsuranceError("CERT_APPROVAL_REQUIRED", "An approval id is required to issue a certificate.");
  }
  if (certificate.approvalId && certificate.approvalId !== approvalId) {
    throw new InsuranceError(
      "CERT_APPROVAL_MISMATCH",
      "This approval was not proposed for this certificate. Re-prepare the certificate for a fresh review.",
    );
  }
  const approval = await stores.governance.approvals.get(approvalId, workspaceId);
  if (!approval) {
    throw new InsuranceError("CERT_APPROVAL_NOT_FOUND", "The issue_certificate approval was not found in this workspace.");
  }
  const policy = await stores.certificates.findPolicy(certificate.policyId, workspaceId);
  if (!policy) {
    throw new InsuranceError("CERT_POLICY_NOT_FOUND", "The issuing policy no longer exists.");
  }

  // Re-verify everything before rendering a single byte.
  assertApprovalMatchesCertificate(certificate, policy, approval);

  const payload = buildCertificatePayload(
    certificate.id,
    policy,
    {
      holderName: certificate.holderName,
      holderAddress: certificate.holderAddress,
      additionalInsured: certificate.additionalInsured,
      waiverOfSubrogation: certificate.waiverOfSubrogation,
      operationsDescription: certificate.operationsDescription,
      requestedBy: certificate.requestedBy,
      requestedFor: certificate.requestedFor,
    },
    {
      issueDate: certificate.issueDate,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
    },
  );
  const pdfBytes = renderCertificatePdf(payload);
  const pdfHash = hashCertificatePdf(pdfBytes);
  const issuedAt = new Date();

  const issued = await stores.certificates.update(certificate.id, workspaceId, {
    status: "issued",
    issuedBy,
    issuedAt,
    pdfBytes,
    pdfHash,
  });

  // Stamp the audit record with issuedAt and the full holder audit trail:
  // who requested, for which contract/client, who issued.
  await stores.governance.audit.create({
    workspaceId,
    action: "issue_certificate",
    subjectType: "certificate",
    subjectId: certificate.id,
    result: "approved",
    decidedBy: issuedBy,
    decidedAt: issuedAt,
    payload,
    vendorTransactionRef: `coi-pdf:${pdfHash.slice(0, 16)}`,
    note:
      `Certificate issued to holder "${certificate.holderName}"` +
      (certificate.requestedFor ? ` for ${certificate.requestedFor}` : "") +
      ` by ${issuedBy}` +
      (certificate.requestedBy ? ` (requested by ${certificate.requestedBy})` : "") +
      ".",
  });

  return { certificate: issued, pdfBytes, pdfHash };
}

// ---------------------------------------------------------------------------
// Revoke: issued → revoked, with reason + audit event.
// ---------------------------------------------------------------------------

export async function revokeCertificate(
  workspaceId: string,
  certificateId: string,
  revokedBy: string,
  reason: string,
  stores: CertificateStores = prismaCertificateStores(),
): Promise<CertificateRecord> {
  const certificate = await stores.certificates.get(certificateId, workspaceId);
  if (!certificate) {
    throw new InsuranceError("CERT_NOT_FOUND", "Certificate not found in this workspace.");
  }
  if (certificate.status !== "issued") {
    throw new InsuranceError(
      "CERT_INVALID_CERT_STATUS",
      `Only issued certificates can be revoked. This one is ${certificate.status}.`,
    );
  }
  const cleanReason = reason?.trim();
  if (!cleanReason) {
    throw new InsuranceError("CERT_REVOKE_REASON_REQUIRED", "A revocation reason is required.");
  }
  const revokedAt = new Date();
  const revoked = await stores.certificates.update(certificate.id, workspaceId, {
    status: "revoked",
    revokedReason: cleanReason,
    revokedAt,
    revokedBy,
  });
  await stores.governance.audit.create({
    workspaceId,
    action: "issue_certificate",
    subjectType: "certificate",
    subjectId: certificate.id,
    result: "approved",
    decidedBy: revokedBy,
    decidedAt: revokedAt,
    payload: {
      revoked: true,
      holderName: certificate.holderName,
      requestedFor: certificate.requestedFor,
      pdfHash: certificate.pdfHash,
    },
    vendorTransactionRef: null,
    note: `Certificate revoked by ${revokedBy}: ${cleanReason}.`,
  });
  return revoked;
}

// ---------------------------------------------------------------------------
// PDF: ACORD-25-style certificate, hand-rolled minimal PDF.
// ---------------------------------------------------------------------------

/**
 * Hand-rolled minimal PDF (uncompressed, one page) rather than pdf-lib:
 * a single-page ACORD-25-style certificate needs only static text, and a
 * hand-rolled writer keeps the dependency tree unchanged (the repo
 * deliberately carries no PDF dependency — see lib/studio/creatives.ts).
 * Nothing invented: null fields render "not confirmed".
 */

export function hashCertificatePdf(pdfBytes: Buffer): string {
  return createHash("sha256").update(pdfBytes).digest("hex");
}

function pdfText(s: string): string {
  // WinAnsi-safe: non-printable/latin chars become "?", then escape PDF
  // string syntax.
  const safe = String(s).replace(/[^\x20-\x7E]/g, "?");
  return `(${safe.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

function fmtCoiMoney(cents: number | null): string {
  if (cents == null) return "not confirmed";
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtCoiDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "not confirmed" : d.toISOString().slice(0, 10);
}

interface PdfLine {
  font: "F1" | "F2";
  size: number;
  x: number;
  y: number;
  text: string;
}

/** Build the ACORD-25-style content lines from the verified payload. */
export function certificatePdfLines(payload: CertificatePayload): PdfLine[] {
  const L: PdfLine[] = [];
  const M = 56; // left margin
  let y = 748;

  L.push({ font: "F2", size: 16, x: M, y, text: "CERTIFICATE OF LIABILITY INSURANCE" });
  y -= 16;
  L.push({ font: "F1", size: 9, x: M, y, text: "ACORD 25 style — rendered from in-force policy truth. Never from drafts or quotes." });
  y -= 20;

  const section = (title: string) => {
    L.push({ font: "F2", size: 11, x: M, y, text: title });
    y -= 14;
  };
  const row = (label: string, value: string | null) => {
    L.push({ font: "F2", size: 10, x: M, y, text: `${label}:` });
    L.push({ font: "F1", size: 10, x: M + 170, y, text: value ?? "not confirmed" });
    y -= 13;
  };
  const free = (text: string) => {
    L.push({ font: "F1", size: 10, x: M, y, text });
    y -= 13;
  };

  section("PRODUCER");
  free("Marketr Insurance — software only. Licensed producer of record on file.");
  y -= 4;

  section("NAMED INSURED");
  row("Named insured", payload.namedInsured);
  row("Policy number", payload.policyNumber);
  row("Carrier", payload.carrier);
  row("Line", payload.lineLabel);
  y -= 4;

  section("COVERAGES");
  row("Each occurrence", fmtCoiMoney(payload.limitPerOccurrenceCents));
  row("General aggregate", fmtCoiMoney(payload.limitAggregateCents));
  row("Deductible", payload.deductibleCents == null ? "not confirmed" : fmtCoiMoney(payload.deductibleCents));
  row("Policy effective", fmtCoiDate(payload.effectiveDate));
  row("Policy expiry", fmtCoiDate(payload.expiryDate));
  y -= 4;

  section("ENDORSEMENTS");
  row("Additional insured", payload.additionalInsured ? "YES" : "NO");
  row("Waiver of subrogation", payload.waiverOfSubrogation ? "YES" : "NO");
  y -= 4;

  section("CERTIFICATE HOLDER");
  row("Holder", payload.holderName);
  row("Address", payload.holderAddress ?? "not confirmed");
  y -= 4;

  section("VALIDITY");
  row("Issue date", fmtCoiDate(payload.issueDate));
  row("Valid from", fmtCoiDate(payload.validFrom));
  row("Valid to", fmtCoiDate(payload.validTo));
  y -= 4;

  section("DESCRIPTION OF OPERATIONS");
  const ops = payload.operationsDescription ?? "not confirmed";
  // Wrap long operations text at ~95 chars per line.
  const words = ops.split(/\s+/);
  let buf = "";
  for (const w of words) {
    const next = buf ? `${buf} ${w}` : w;
    if (next.length > 95) {
      free(buf);
      buf = w;
    } else {
      buf = next;
    }
  }
  if (buf) free(buf);
  y -= 4;

  section("REQUEST");
  row("Requested by", payload.requestedBy ?? "not confirmed");
  row("Requested for", payload.requestedFor ?? "not confirmed");
  y -= 6;

  // Footer disclaimer (paraphrased, not verbatim ACORD text).
  L.push({ font: "F1", size: 8, x: M, y, text: "This certificate is issued as a matter of information only and confers no rights upon the certificate" });
  y -= 10;
  L.push({ font: "F1", size: 8, x: M, y, text: "holder. It does not amend, extend, or alter the coverage afforded by the policy referenced above. Coverage" });
  y -= 10;
  L.push({ font: "F1", size: 8, x: M, y, text: "fields marked \"not confirmed\" were not verified on the issuing policy at the time of issuance." });

  return L;
}

/** Serialize one page of text lines into a minimal uncompressed PDF. */
export function renderCertificatePdf(payload: CertificatePayload): Buffer {
  const lines = certificatePdfLines(payload);
  const content = lines
    .map((l) => `BT /${l.font} ${l.size} Tf ${l.x} ${l.y} Td ${pdfText(l.text)} Tj ET`)
    .join("\n");

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
  ];

  const header = "%PDF-1.4\n";
  let body = "";
  const offsets: number[] = [];
  let cursor = Buffer.byteLength(header, "utf8");
  for (let i = 0; i < objects.length; i++) {
    const obj = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    offsets.push(cursor);
    body += obj;
    cursor += Buffer.byteLength(obj, "utf8");
  }
  const xrefOffset = cursor;
  const entry = (n: number) => `${n.toString().padStart(10, "0")} 00000 n \n`;
  const xref =
    `xref\n0 ${objects.length + 1}\n` +
    `0000000000 65535 f \n` +
    offsets.map(entry).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(header + body + xref, "utf8");
}

/** Serialize a certificate row for API/UI/MCP responses. */
export function serializeCertificate(
  c: CertificateRecord,
  extras?: {
    policyNumber?: string;
    carrierName?: string;
    lineLabel?: string;
    approvalStatus?: string | null;
    /** The proposed approval's payload snapshot — what the human reviews. */
    approvalPayload?: Record<string, unknown> | null;
  },
): Record<string, unknown> {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    policyId: c.policyId,
    policyNumber: extras?.policyNumber ?? null,
    carrierName: extras?.carrierName ?? null,
    lineLabel: extras?.lineLabel ?? null,
    holderName: c.holderName,
    holderAddress: c.holderAddress,
    additionalInsured: c.additionalInsured,
    waiverOfSubrogation: c.waiverOfSubrogation,
    operationsDescription: c.operationsDescription,
    issueDate: c.issueDate.toISOString(),
    validFrom: c.validFrom.toISOString(),
    validTo: c.validTo.toISOString(),
    status: c.status,
    requestedBy: c.requestedBy,
    requestedFor: c.requestedFor,
    issuedBy: c.issuedBy,
    issuedAt: c.issuedAt ? c.issuedAt.toISOString() : null,
    approvalId: c.approvalId,
    approvalStatus: extras?.approvalStatus ?? null,
    approvalPayload: extras?.approvalPayload ?? null,
    pdfHash: c.pdfHash,
    revokedReason: c.revokedReason,
    revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
    revokedBy: c.revokedBy,
  };
}
