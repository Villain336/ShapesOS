// Marketr — Wave 2 Insurance slice 3b: bind execution + zero-custody payment
// handoff + bound-quote → Policy lineage.
//
// SPEC-INSURANCE.md §3 (binding flow), §4.3 (bind_policy heavy gate), §4.4
// (money red-lane). Tico's binding decisions:
// - LICENSED PARTNER model: the partner holds the licenses; the licensed
//   rail (CoverForce + appointed market access) is the binder of record.
// - Money red-lane: propose → explicit human approval → licensed rail
//   executes. No auto-bind in v1. executeBind is the ONLY execution
//   entrypoint — the API route and the MCP tool both funnel through it.
// - Zero custody: the OS never holds, floats, or routes premium funds.
//   Payments are carrier-direct through the vendor rail; the
//   InsurancePaymentHandoff record documents that movement and asserts in
//   code that no OS account fields exist on it.
// - No invented coverage: the policy row copies limits/premium/carrier/dates
//   from VENDOR data only; anything the vendor does not return reads
//   "not confirmed" (null), never a guess.
//
// Fail-closed ordering inside executeBind: quote → approval (+ disclosure
// re-verification against the CURRENT quote) → licensed partner → vendor
// bind (idempotent) → persist policy → mark quote bound → handoff → audit
// stamp. Any step throwing aborts the bind with a named error code.

import { addMonthsClamped } from "@/lib/time/zoned";
import { InsuranceError, validatePolicyInput, type InsuranceLineOfBusiness } from "./types";
import { assertQuoteTransition } from "./quoting";
import {
  approvalKindForAction,
  prismaGovernedApprovalStore,
  type ApprovalRecord,
  type GovernedApprovalStore,
} from "./governance";
import {
  prismaLicensedPartnerStore,
  requireAppointedPartner,
  type LicensedPartnerRecord,
  type LicensedPartnerStore,
} from "./partner";
import { CoverForceVendor } from "./coverforce";
import {
  InsuranceVendorError,
  type InsuranceVendor,
  type VendorBindResult,
} from "./mock-vendor";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Zero-custody assertion.
// ---------------------------------------------------------------------------

/** The only custody assertion a payment handoff may carry. */
export const CUSTODY_ASSERTION = "carrier_direct" as const;

/**
 * OS account / money-movement fields that must NEVER appear on a payment
 * handoff record. The record documents carrier-direct movement; the OS holds
 * nothing, so any of these keys is a custody violation, not a new feature.
 */
const FORBIDDEN_CUSTODY_FIELDS = [
  "osAccountId",
  "osAccountNumber",
  "accountNumber",
  "routingNumber",
  "iban",
  "walletId",
  "balanceCents",
  "floatAccountId",
  "escrowAccountId",
  "osLedgerId",
  "merchantAccountId",
  "payoutAccountId",
] as const;

/** The exact field set an InsurancePaymentHandoff create may carry. */
const PAYMENT_HANDOFF_FIELDS = [
  "workspaceId",
  "policyId",
  "amountCents",
  "payeeCarrier",
  "payeeCarrierNaic",
  "vendorPaymentRef",
  "custodyAssertion",
] as const;

/**
 * Code-level zero-custody assertion. Throws ZERO_CUSTODY_VIOLATION when the
 * handoff payload carries an OS account field, an unknown field, or anything
 * other than the "carrier_direct" assertion — so a future edit that adds a
 * custody field fails loudly instead of silently.
 */
export function assertZeroCustodyHandoff(input: Record<string, unknown>): void {
  for (const field of FORBIDDEN_CUSTODY_FIELDS) {
    if (field in input) {
      throw new InsuranceError(
        "ZERO_CUSTODY_VIOLATION",
        `Zero-custody violation: payment handoff records must never carry OS ` +
          `account fields (found "${field}"). Premium funds move ` +
          `carrier-direct; the OS holds nothing.`,
      );
    }
  }
  const unknownFields = Object.keys(input).filter(
    (k) => !(PAYMENT_HANDOFF_FIELDS as readonly string[]).includes(k),
  );
  if (unknownFields.length > 0) {
    throw new InsuranceError(
      "ZERO_CUSTODY_VIOLATION",
      `Zero-custody violation: unexpected fields on payment handoff record: ` +
        `${unknownFields.join(", ")}. The handoff schema is closed by design.`,
    );
  }
  if (input["custodyAssertion"] !== CUSTODY_ASSERTION) {
    throw new InsuranceError(
      "ZERO_CUSTODY_VIOLATION",
      `Zero-custody violation: custodyAssertion must be "${CUSTODY_ASSERTION}".`,
    );
  }
  const payee = input["payeeCarrier"];
  if (typeof payee !== "string" || payee.trim().length === 0) {
    throw new InsuranceError(
      "ZERO_CUSTODY_VIOLATION",
      "Zero-custody violation: payeeCarrier (the carrier receiving the premium) is required.",
    );
  }
}

// ---------------------------------------------------------------------------
// Bind disclosure (approval → execution re-verification).
// ---------------------------------------------------------------------------

export interface BindDisclosure {
  carrier: string;
  premiumCents: number;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  /** ISO date the approver saw. */
  effectiveDate: string;
  expiryDate?: string | null;
}

/**
 * Extract the bind disclosure from an approval payload. Fail closed: a bind
 * may only execute on a fully-disclosed approval (SPEC §4.3 — the approver
 * must have seen premium, limits, carrier, effective dates).
 */
export function extractBindDisclosure(payload: unknown): BindDisclosure {
  const p = (payload ?? {}) as Record<string, unknown>;
  const missing: string[] = [];

  const carrier = p["carrier"];
  const premiumCents = p["premiumCents"];
  const limitPerOccurrenceCents = p["limitPerOccurrenceCents"];
  const limitAggregateCents = p["limitAggregateCents"];
  const effectiveDate = p["effectiveDate"];

  if (typeof carrier !== "string" || carrier.trim().length === 0) missing.push("carrier");
  if (
    typeof premiumCents !== "number" ||
    !Number.isInteger(premiumCents) ||
    premiumCents < 0
  ) {
    missing.push("premiumCents");
  }
  for (const [label, v] of [
    ["limitPerOccurrenceCents", limitPerOccurrenceCents],
    ["limitAggregateCents", limitAggregateCents],
  ] as const) {
    if (v !== null && v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 0)) {
      missing.push(label);
    }
  }
  if (typeof effectiveDate !== "string" || effectiveDate.trim().length === 0) {
    missing.push("effectiveDate");
  } else if (Number.isNaN(new Date(effectiveDate).getTime())) {
    missing.push("effectiveDate");
  }

  if (missing.length > 0) {
    throw new InsuranceError(
      "BIND_DISCLOSURE_INCOMPLETE",
      `Cannot execute bind: the approval disclosure is incomplete or invalid. ` +
        `Problem fields: ${missing.join(", ")}.`,
    );
  }
  return {
    carrier: (carrier as string).trim(),
    premiumCents: premiumCents as number,
    limitPerOccurrenceCents: (limitPerOccurrenceCents as number | null | undefined) ?? null,
    limitAggregateCents: (limitAggregateCents as number | null | undefined) ?? null,
    effectiveDate: (effectiveDate as string).trim(),
    expiryDate:
      typeof p["expiryDate"] === "string" ? (p["expiryDate"] as string).trim() : null,
  };
}

function toDayString(value: string | Date): string | null {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * The quote may record the vendor's proposed effective date in its raw
 * payload (quote rows carry no dedicated effective-date column). When the
 * quote records one, the approval's must match; when it records none, the
 * human-approved disclosure stands (it was enforced complete at propose
 * time by BIND_DISCLOSURE_INCOMPLETE).
 */
export function quoteEffectiveDate(rawPayload: unknown): string | null {
  const p = (rawPayload ?? {}) as Record<string, unknown>;
  const v = p["effectiveDate"];
  if (typeof v !== "string" || v.trim().length === 0) return null;
  return toDayString(v.trim());
}

/**
 * Re-verify at execution time: the quote must not have drifted since the
 * human approved it. Any drift in carrier, premium, limits, or (recorded)
 * effective date fails closed with BIND_DISCLOSURE_MISMATCH — the approval
 * no longer describes the thing being bound.
 */
export function assertDisclosureMatchesQuote(
  quote: Pick<
    BindQuoteRecord,
    | "carrierName"
    | "quotedPremiumCents"
    | "limitPerOccurrenceCents"
    | "limitAggregateCents"
    | "rawPayload"
  >,
  disclosure: BindDisclosure,
): void {
  const mismatches: string[] = [];
  if (disclosure.carrier.toLowerCase() !== quote.carrierName.trim().toLowerCase()) {
    mismatches.push("carrier");
  }
  if (disclosure.premiumCents !== quote.quotedPremiumCents) {
    mismatches.push("premiumCents");
  }
  if (disclosure.limitPerOccurrenceCents !== quote.limitPerOccurrenceCents) {
    mismatches.push("limitPerOccurrenceCents");
  }
  if (disclosure.limitAggregateCents !== quote.limitAggregateCents) {
    mismatches.push("limitAggregateCents");
  }
  const quoteEff = quoteEffectiveDate(quote.rawPayload);
  if (quoteEff !== null) {
    const disclosedEff = toDayString(disclosure.effectiveDate);
    if (disclosedEff !== quoteEff) mismatches.push("effectiveDate");
  }
  if (mismatches.length > 0) {
    throw new InsuranceError(
      "BIND_DISCLOSURE_MISMATCH",
      `Cannot execute bind: the quote changed since approval (drifted fields: ` +
        `${mismatches.join(", ")}). Ask the human to re-approve the current quote.`,
    );
  }
}

/**
 * Renewal lineage convention: a renewal quote references the prior term's
 * policy id in its raw payload (`renewalOfPolicyId`). Binding then sets the
 * new policy's priorPolicyId — the Policy → Policy lineage link (§4.2).
 */
export function extractRenewalOfPolicyId(rawPayload: unknown): string | null {
  const p = (rawPayload ?? {}) as Record<string, unknown>;
  const v = p["renewalOfPolicyId"];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** Idempotency key for a bind execution: derived from (quoteId, approvalId). */
/**
 * Conventional 12-month term end: same calendar day next year, clamped to
 * the month's length (2028-02-29 → 2029-02-28, not 2029-03-01 — a
 * setUTCFullYear(+1) rolls the leap day over and makes the term a day too
 * long). Time of day is kept.
 */
export function policyTermEnd(effectiveAt: Date): Date {
  const t = addMonthsClamped(
    effectiveAt.getUTCFullYear(),
    effectiveAt.getUTCMonth() + 1,
    effectiveAt.getUTCDate(),
    12,
  );
  const msIntoDay = effectiveAt.getTime() - Date.UTC(
    effectiveAt.getUTCFullYear(),
    effectiveAt.getUTCMonth(),
    effectiveAt.getUTCDate(),
  );
  return new Date(Date.UTC(t.year, t.month - 1, t.day) + msIntoDay);
}

export function bindIdempotencyKey(quoteId: string, approvalId: string): string {
  return `bind:${quoteId}:${approvalId}`;
}

// ---------------------------------------------------------------------------
// Store ports (persistence-agnostic; Prisma default, stubs in tests).
// ---------------------------------------------------------------------------

export interface BindQuoteSubmission {
  id: string;
  line: InsuranceLineOfBusiness;
  applicantName: string;
  state: string;
}

export interface BindQuoteRecord {
  id: string;
  workspaceId: string;
  status: string;
  carrierName: string;
  quotedPremiumCents: number | null;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  quoteExpiry: Date | null;
  rawPayload: unknown;
  policyId: string | null;
  submission: BindQuoteSubmission;
}

export interface NewBoundPolicy {
  workspaceId: string;
  carrierId: string;
  policyNumber: string;
  line: InsuranceLineOfBusiness;
  namedInsured: string;
  effectiveAt: Date;
  expiresAt: Date;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  deductibleCents: number | null;
  annualPremiumCents: number | null;
  priorPolicyId: string | null;
  source: string;
  rawPayload: Record<string, unknown>;
}

export interface BindPolicyRecord {
  id: string;
  workspaceId: string;
  policyNumber: string;
  carrierName: string;
  line: string;
  namedInsured: string;
  effectiveAt: Date;
  expiresAt: Date;
  annualPremiumCents: number | null;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  status: string;
  source: string;
  priorPolicyId: string | null;
  rawPayload: unknown;
}

export interface NewPaymentHandoff {
  workspaceId: string;
  policyId: string;
  amountCents: number | null;
  payeeCarrier: string;
  payeeCarrierNaic: string | null;
  vendorPaymentRef: string | null;
  custodyAssertion: typeof CUSTODY_ASSERTION;
}

export interface PaymentHandoffRecord {
  id: string;
  workspaceId: string;
  policyId: string;
  amountCents: number | null;
  payeeCarrier: string;
  payeeCarrierNaic: string | null;
  vendorPaymentRef: string | null;
  custodyAssertion: string;
  createdAt: Date;
}

export interface BindQuoteStore {
  get(workspaceId: string, quoteId: string): Promise<BindQuoteRecord | null>;
  /**
   * Atomically move quoted → bound and link the policy. Throws
   * BIND_RACE_LOST when the quote is no longer quoted (a concurrent
   * execution won) — the caller then replays instead of double-binding.
   */
  markBound(workspaceId: string, quoteId: string, policyId: string): Promise<BindQuoteRecord>;
}

export interface BindPolicyStore {
  get(workspaceId: string, policyId: string): Promise<BindPolicyRecord | null>;
  findByNumber(workspaceId: string, policyNumber: string): Promise<BindPolicyRecord | null>;
  /**
   * Throws POLICY_NUMBER_CONFLICT when the policy number already exists —
   * the vendor bind was idempotent, so this means a concurrent execution
   * already persisted the policy; the caller replays.
   */
  create(input: NewBoundPolicy): Promise<BindPolicyRecord>;
}

export interface BindCarrierStore {
  upsert(
    workspaceId: string,
    name: string,
    line: InsuranceLineOfBusiness,
  ): Promise<{ id: string; naicCode: string | null }>;
}

export interface PaymentHandoffStore {
  create(input: NewPaymentHandoff): Promise<PaymentHandoffRecord>;
  findByPolicy(workspaceId: string, policyId: string): Promise<PaymentHandoffRecord | null>;
}

export interface BindAuditStore {
  /**
   * Stamp the vendor transaction ref onto this execution's approved bind
   * audit events — fills what slice 3a's decide step left null. Returns the
   * number of events stamped.
   */
  stampVendorTransactionRef(
    workspaceId: string,
    subjectId: string,
    vendorTransactionRef: string,
  ): Promise<number>;
}

export interface BindingDeps {
  quotes: BindQuoteStore;
  policies: BindPolicyStore;
  carriers: BindCarrierStore;
  handoffs: PaymentHandoffStore;
  approvals: GovernedApprovalStore;
  audit: BindAuditStore;
  partners: LicensedPartnerStore;
  vendor: InsuranceVendor;
}

export function isLiveVendor(vendor: InsuranceVendor): boolean {
  return (vendor as { isLive?: unknown }).isLive === true;
}

function toBindQuoteRecord(row: {
  id: string;
  workspaceId: string;
  status: string;
  carrierName: string;
  quotedPremiumCents: number | null;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  quoteExpiry: Date | null;
  rawPayload: unknown;
  policyId: string | null;
  submission: { id: string; line: InsuranceLineOfBusiness; applicantName: string; state: string };
}): BindQuoteRecord {
  return { ...row };
}

function toBindPolicyRecord(row: {
  id: string;
  workspaceId: string;
  policyNumber: string;
  line: string;
  namedInsured: string;
  effectiveAt: Date;
  expiresAt: Date;
  annualPremiumCents: number | null;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  status: string;
  source: string;
  priorPolicyId: string | null;
  rawPayload: unknown;
  carrier: { name: string };
}): BindPolicyRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    policyNumber: row.policyNumber,
    carrierName: row.carrier.name,
    line: row.line,
    namedInsured: row.namedInsured,
    effectiveAt: row.effectiveAt,
    expiresAt: row.expiresAt,
    annualPremiumCents: row.annualPremiumCents,
    limitPerOccurrenceCents: row.limitPerOccurrenceCents,
    limitAggregateCents: row.limitAggregateCents,
    status: row.status,
    source: row.source,
    priorPolicyId: row.priorPolicyId,
    rawPayload: row.rawPayload,
  };
}

function toHandoffRecord(row: {
  id: string;
  workspaceId: string;
  policyId: string;
  amountCents: number | null;
  payeeCarrier: string;
  payeeCarrierNaic: string | null;
  vendorPaymentRef: string | null;
  custodyAssertion: string;
  createdAt: Date;
}): PaymentHandoffRecord {
  return { ...row };
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: unknown }).code === "P2002"
  );
}

export function prismaBindingDeps(vendor?: InsuranceVendor): BindingDeps {
  const activeVendor = vendor ?? new CoverForceVendor({ mode: "fixture" });
  return {
    vendor: activeVendor,
    partners: prismaLicensedPartnerStore(),
    approvals: prismaGovernedApprovalStore(),
    quotes: {
      async get(workspaceId, quoteId) {
        const q = await prisma.insuranceQuote.findFirst({
          where: { id: quoteId, workspaceId },
          include: {
            submission: {
              select: { id: true, line: true, applicantName: true, state: true },
            },
          },
        });
        if (!q || !q.submission) return null;
        return toBindQuoteRecord({
          id: q.id,
          workspaceId: q.workspaceId,
          status: q.status,
          carrierName: q.carrierName,
          quotedPremiumCents: q.quotedPremiumCents,
          limitPerOccurrenceCents: q.limitPerOccurrenceCents,
          limitAggregateCents: q.limitAggregateCents,
          quoteExpiry: q.quoteExpiry,
          rawPayload: q.rawPayload,
          policyId: q.policyId,
          submission: {
            id: q.submission.id,
            line: q.submission.line as InsuranceLineOfBusiness,
            applicantName: q.submission.applicantName,
            state: q.submission.state,
          },
        });
      },
      async markBound(workspaceId, quoteId, policyId) {
        assertQuoteTransition("quoted", "bound");
        const updated = await prisma.insuranceQuote.updateMany({
          where: { id: quoteId, workspaceId, status: "quoted" },
          data: { status: "bound", policyId },
        });
        if (updated.count === 0) {
          throw new InsuranceError(
            "BIND_RACE_LOST",
            "Quote was bound by a concurrent execution; replaying instead of double-binding.",
          );
        }
        const q = await prisma.insuranceQuote.findFirstOrThrow({
          where: { id: quoteId, workspaceId },
          include: {
            submission: {
              select: { id: true, line: true, applicantName: true, state: true },
            },
          },
        });
        return toBindQuoteRecord({
          id: q.id,
          workspaceId: q.workspaceId,
          status: q.status,
          carrierName: q.carrierName,
          quotedPremiumCents: q.quotedPremiumCents,
          limitPerOccurrenceCents: q.limitPerOccurrenceCents,
          limitAggregateCents: q.limitAggregateCents,
          quoteExpiry: q.quoteExpiry,
          rawPayload: q.rawPayload,
          policyId: q.policyId,
          submission: {
            id: q.submission.id,
            line: q.submission.line as InsuranceLineOfBusiness,
            applicantName: q.submission.applicantName,
            state: q.submission.state,
          },
        });
      },
    },
    policies: {
      async get(workspaceId, policyId) {
        const p = await prisma.insurancePolicy.findFirst({
          where: { id: policyId, workspaceId },
          include: { carrier: { select: { name: true } } },
        });
        return p
          ? toBindPolicyRecord({ ...p, status: p.status as string, line: p.line as string })
          : null;
      },
      async findByNumber(workspaceId, policyNumber) {
        const p = await prisma.insurancePolicy.findFirst({
          where: { workspaceId, policyNumber },
          include: { carrier: { select: { name: true } } },
        });
        return p
          ? toBindPolicyRecord({ ...p, status: p.status as string, line: p.line as string })
          : null;
      },
      async create(input) {
        validatePolicyInput({
          policyNumber: input.policyNumber,
          carrierId: input.carrierId,
          line: input.line,
          namedInsured: input.namedInsured,
          effectiveAt: input.effectiveAt,
          expiresAt: input.expiresAt,
          limitPerOccurrenceCents: input.limitPerOccurrenceCents,
          limitAggregateCents: input.limitAggregateCents,
          deductibleCents: input.deductibleCents,
          annualPremiumCents: input.annualPremiumCents,
        });
        try {
          const p = await prisma.insurancePolicy.create({
            data: {
              workspaceId: input.workspaceId,
              carrierId: input.carrierId,
              policyNumber: input.policyNumber,
              line: input.line,
              namedInsured: input.namedInsured,
              effectiveAt: input.effectiveAt,
              expiresAt: input.expiresAt,
              limitPerOccurrenceCents: input.limitPerOccurrenceCents,
              limitAggregateCents: input.limitAggregateCents,
              deductibleCents: input.deductibleCents,
              annualPremiumCents: input.annualPremiumCents,
              status: "active",
              source: input.source,
              priorPolicyId: input.priorPolicyId,
              rawPayload: input.rawPayload as object,
            },
            include: { carrier: { select: { name: true } } },
          });
          return toBindPolicyRecord({
            ...p,
            status: p.status as string,
            line: p.line as string,
          });
        } catch (e) {
          if (isUniqueViolation(e)) {
            throw new InsuranceError(
              "POLICY_NUMBER_CONFLICT",
              "Policy number already exists — the vendor bind was idempotent, " +
                "so a concurrent execution already persisted this policy; replaying.",
            );
          }
          throw e;
        }
      },
    },
    carriers: {
      async upsert(workspaceId, name, line) {
        const c = await prisma.insuranceCarrier.upsert({
          where: { workspaceId_name: { workspaceId, name } },
          update: {},
          create: {
            workspaceId,
            name,
            appointmentPath: "dais_market_access",
            linesSupported: [line],
          },
        });
        return { id: c.id, naicCode: c.naicCode };
      },
    },
    handoffs: {
      async create(input) {
        assertZeroCustodyHandoff(input as unknown as Record<string, unknown>);
        const r = await prisma.insurancePaymentHandoff.create({
          data: {
            workspaceId: input.workspaceId,
            policyId: input.policyId,
            amountCents: input.amountCents,
            payeeCarrier: input.payeeCarrier,
            payeeCarrierNaic: input.payeeCarrierNaic,
            vendorPaymentRef: input.vendorPaymentRef,
            custodyAssertion: input.custodyAssertion,
          },
        });
        return toHandoffRecord(r);
      },
      async findByPolicy(workspaceId, policyId) {
        const r = await prisma.insurancePaymentHandoff.findFirst({
          where: { workspaceId, policyId },
          orderBy: { createdAt: "asc" },
        });
        return r ? toHandoffRecord(r) : null;
      },
    },
    audit: {
      async stampVendorTransactionRef(workspaceId, subjectId, vendorTransactionRef) {
        const r = await prisma.insuranceAuditEvent.updateMany({
          where: {
            workspaceId,
            action: "bind_policy",
            subjectType: "quote",
            subjectId,
            result: "approved",
            vendorTransactionRef: null,
          },
          data: { vendorTransactionRef },
        });
        return r.count;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// executeBind — the ONLY bind execution entrypoint.
// ---------------------------------------------------------------------------

export interface ExecuteBindInput {
  workspaceId: string;
  quoteId: string;
  approvalId: string;
  requestedBy?: string;
}

export interface ExecuteBindResult {
  policy: BindPolicyRecord;
  paymentHandoff: PaymentHandoffRecord;
  live: boolean;
  /** True when this call replayed an earlier execution instead of binding. */
  replayed: boolean;
}

/**
 * Verify the bind approval: it must exist, be an approved
 * insurance_bind_policy approval for THIS quote, carry a complete
 * disclosure, and that disclosure must still match the quote's current
 * terms (no drift since the human approved).
 */
function verifyBindApproval(
  approval: ApprovalRecord | null,
  quote: BindQuoteRecord,
  approvalId: string,
): ApprovalRecord {
  if (!approval) {
    throw new InsuranceError(
      "APPROVAL_NOT_FOUND",
      "Bind approval not found in this workspace.",
    );
  }
  if (approval.kind !== approvalKindForAction("bind_policy")) {
    throw new InsuranceError(
      "APPROVAL_KIND_MISMATCH",
      `Approval ${approvalId} is not a bind_policy approval (kind: ${approval.kind}).`,
    );
  }
  const p = (approval.payload ?? {}) as Record<string, unknown>;
  if (
    p["action"] !== "bind_policy" ||
    p["subjectType"] !== "quote" ||
    p["subjectId"] !== quote.id
  ) {
    throw new InsuranceError(
      "APPROVAL_SUBJECT_MISMATCH",
      `Approval ${approvalId} does not authorize binding this quote.`,
    );
  }
  if (approval.status !== "approved") {
    throw new InsuranceError(
      "APPROVAL_NOT_APPROVED",
      `Cannot execute bind: approval ${approvalId} is ${approval.status}. ` +
        `Binding requires explicit human approval — no auto-bind in v1.`,
    );
  }
  const disclosure = extractBindDisclosure(approval.payload);
  assertDisclosureMatchesQuote(quote, disclosure);
  return approval;
}

async function replayExistingPolicy(
  deps: BindingDeps,
  workspaceId: string,
  policyNumber: string,
): Promise<ExecuteBindResult> {
  const policy = await deps.policies.findByNumber(workspaceId, policyNumber);
  const handoff =
    policy !== null ? await deps.handoffs.findByPolicy(workspaceId, policy.id) : null;
  if (!policy || !handoff) {
    // The quote claims to be bound but the policy/handoff rows are missing —
    // fail closed rather than bind again and risk a duplicate at the carrier.
    throw new InsuranceError(
      "QUOTE_STATE_INCONSISTENT",
      "Quote is marked bound but its policy record is missing. Refusing to " +
        "re-bind; reconcile the policy record first.",
    );
  }
  return { policy, paymentHandoff: handoff, live: isLiveVendor(deps.vendor), replayed: true };
}

/**
 * Execute a bind: the ONLY entrypoint. Steps in order, each fail-closed:
 * (a) quote exists, is quoted, not expired; (b) the approval is an approved
 * bind_policy approval for this quote whose disclosure still matches the
 * quote; (c) an appointed licensed partner exists; (d) vendor.bind with the
 * (quoteId, approvalId) idempotency key; (e) persist the policy from vendor
 * data only; (f) write the zero-custody payment handoff; (g) stamp the audit
 * event with the vendor transaction ref.
 *
 * Double-execution returns the existing policy (replayed: true) — never
 * double-binds.
 */
export async function executeBind(
  input: ExecuteBindInput,
  deps: BindingDeps = prismaBindingDeps(),
): Promise<ExecuteBindResult> {
  const workspaceId = input.workspaceId;

  // (a) Load the quote.
  const quote = await deps.quotes.get(workspaceId, input.quoteId);
  if (!quote) {
    throw new InsuranceError("QUOTE_NOT_FOUND", "Quote not found in this workspace.");
  }

  // (b) Verify the approval FIRST — even on the replay path, so a replay
  // still requires the human's explicit approval to exist and be approved.
  const approval = await deps.approvals.get(input.approvalId, workspaceId);
  const verifiedApproval = verifyBindApproval(approval, quote, input.approvalId);

  if (quote.status === "bound") {
    // Double-execution: return the existing policy, never double-bind.
    if (!quote.policyId) {
      throw new InsuranceError(
        "QUOTE_STATE_INCONSISTENT",
        "Quote is marked bound but links to no policy. Refusing to re-bind; " +
          "reconcile the policy record first.",
      );
    }
    const policy = await deps.policies.get(workspaceId, quote.policyId);
    const handoff =
      policy !== null ? await deps.handoffs.findByPolicy(workspaceId, policy.id) : null;
    if (!policy || !handoff) {
      throw new InsuranceError(
        "QUOTE_STATE_INCONSISTENT",
        "Quote is marked bound but its policy record is missing. Refusing to " +
          "re-bind; reconcile the policy record first.",
      );
    }
    return { policy, paymentHandoff: handoff, live: isLiveVendor(deps.vendor), replayed: true };
  }
  if (quote.status !== "quoted") {
    throw new InsuranceError(
      "QUOTE_NOT_QUOTED",
      `Cannot bind quote with status "${quote.status}": only quoted offers can be bound.`,
    );
  }
  if (quote.quoteExpiry && quote.quoteExpiry.getTime() <= Date.now()) {
    throw new InsuranceError(
      "QUOTE_EXPIRED",
      "Cannot bind: the quote expired. Re-quote before binding.",
    );
  }

  // (c) Licensed-partner gate: the partner holds the licenses; without an
  // appointed partner the bind fails closed here — before any vendor call.
  const partner: LicensedPartnerRecord = await requireAppointedPartner(
    workspaceId,
    deps.partners,
  );

  // (d) Bind on the licensed rail. The idempotency key makes replays safe:
  // the same (quoteId, approvalId) can never mint two policies.
  const idempotencyKey = bindIdempotencyKey(quote.id, verifiedApproval.id);
  let bound: VendorBindResult;
  try {
    bound = await deps.vendor.bind({
      quoteId: quote.id,
      partnerId: partner.id,
      idempotencyKey,
    });
  } catch (e) {
    if (e instanceof InsuranceVendorError) {
      // Vendor refusals (PARTNER_NOT_APPOINTED, VENDOR_NOT_CONFIGURED)
      // propagate with their codes.
      throw new InsuranceError(e.code, e.message);
    }
    throw e;
  }

  const effectiveAt = new Date(bound.effectiveDate);
  if (Number.isNaN(effectiveAt.getTime())) {
    throw new InsuranceError(
      "BIND_VENDOR_DATA_INCOMPLETE",
      "The vendor bind response carried no usable effective date; refusing to " +
        "persist a policy without a term start.",
    );
  }
  // The v1 bind response carries no term end; commercial P&C terms are
  // conventionally 12 months. The assumption is flagged in rawPayload
  // (termEndAssumed) and must be corrected when the carrier's declarations
  // pages arrive — it is never presented as confirmed carrier data.
  const expiresAt = policyTermEnd(effectiveAt);

  // (e) Persist the policy — from VENDOR data only. The v1 bind response
  // carries no limits, so limits read "not confirmed" (null) until the
  // carrier's declarations pages are ingested (slice 1 import). The carrier
  // NAME comes from the quote — it is vendor-originated data from quote
  // time, and the bind response carries no carrier name field.
  const carrier = await deps.carriers.upsert(
    workspaceId,
    quote.carrierName,
    quote.submission.line,
  );
  const renewalOfPolicyId = extractRenewalOfPolicyId(quote.rawPayload);
  let priorPolicyId: string | null = null;
  let renewalOfPolicyIdUnresolved: string | null = null;
  if (renewalOfPolicyId) {
    const prior = await deps.policies.get(workspaceId, renewalOfPolicyId);
    if (prior) {
      priorPolicyId = prior.id;
    } else {
      // The reference names a policy outside this workspace (or a mistyped
      // id) — record it, do not invent lineage.
      renewalOfPolicyIdUnresolved = renewalOfPolicyId;
    }
  }
  const policyInput: NewBoundPolicy = {
    workspaceId,
    carrierId: carrier.id,
    policyNumber: bound.policyNumber,
    line: quote.submission.line,
    namedInsured: quote.submission.applicantName,
    effectiveAt,
    expiresAt,
    limitPerOccurrenceCents: null,
    limitAggregateCents: null,
    deductibleCents: null,
    annualPremiumCents: bound.premiumCents,
    priorPolicyId,
    source: deps.vendor.name,
    rawPayload: {
      vendor: deps.vendor.name,
      live: isLiveVendor(deps.vendor),
      quoteId: quote.id,
      approvalId: verifiedApproval.id,
      idempotencyKey,
      carrierConfirmation: bound.carrierConfirmation,
      paymentReference: bound.paymentReference,
      termEndAssumed: true,
      termEndAssumption: "12-month conventional term; correct from carrier declarations pages",
      ...(renewalOfPolicyIdUnresolved
        ? { renewalOfPolicyIdUnresolved }
        : {}),
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    },
  };

  let policy: BindPolicyRecord;
  try {
    policy = await deps.policies.create(policyInput);
  } catch (e) {
    if (e instanceof InsuranceError && e.code === "POLICY_NUMBER_CONFLICT") {
      // A concurrent execution already persisted this idempotent bind.
      return replayExistingPolicy(deps, workspaceId, bound.policyNumber);
    }
    throw e;
  }

  // Quote → policy lineage: quoted → bound + policy link, atomically. A lost
  // race replays the winner's policy instead of double-binding.
  try {
    await deps.quotes.markBound(workspaceId, quote.id, policy.id);
  } catch (e) {
    if (e instanceof InsuranceError && e.code === "BIND_RACE_LOST") {
      return replayExistingPolicy(deps, workspaceId, bound.policyNumber);
    }
    throw e;
  }

  // (f) Zero-custody payment handoff: documents that the premium moves
  // carrier-direct through the vendor rail. The OS holds nothing — the
  // record carries no OS account fields by construction (asserted below).
  const handoff = await deps.handoffs.create({
    workspaceId,
    policyId: policy.id,
    amountCents: bound.premiumCents,
    payeeCarrier: quote.carrierName,
    payeeCarrierNaic: carrier.naicCode,
    vendorPaymentRef: bound.paymentReference,
    custodyAssertion: CUSTODY_ASSERTION,
  });

  // (g) Stamp the audit event: fill the vendorTransactionRef that slice 3a's
  // decide step left null — the carrier's bind confirmation for this action.
  await deps.audit.stampVendorTransactionRef(workspaceId, quote.id, bound.carrierConfirmation);

  return { policy, paymentHandoff: handoff, live: isLiveVendor(deps.vendor), replayed: false };
}

// ---------------------------------------------------------------------------
// Serialization for API / MCP responses.
// ---------------------------------------------------------------------------

export function serializeBindPolicy(policy: BindPolicyRecord): Record<string, unknown> {
  return {
    id: policy.id,
    policyNumber: policy.policyNumber,
    carrierName: policy.carrierName,
    line: policy.line,
    namedInsured: policy.namedInsured,
    effectiveAt: policy.effectiveAt.toISOString(),
    expiresAt: policy.expiresAt.toISOString(),
    annualPremiumCents: policy.annualPremiumCents,
    limitPerOccurrenceCents: policy.limitPerOccurrenceCents,
    limitAggregateCents: policy.limitAggregateCents,
    priorPolicyId: policy.priorPolicyId,
    status: policy.status,
    source: policy.source,
  };
}

export function serializePaymentHandoff(
  handoff: PaymentHandoffRecord,
): Record<string, unknown> {
  return {
    id: handoff.id,
    policyId: handoff.policyId,
    amountCents: handoff.amountCents,
    payeeCarrier: handoff.payeeCarrier,
    payeeCarrierNaic: handoff.payeeCarrierNaic,
    vendorPaymentRef: handoff.vendorPaymentRef,
    custodyAssertion: handoff.custodyAssertion,
    createdAt: handoff.createdAt.toISOString(),
  };
}
