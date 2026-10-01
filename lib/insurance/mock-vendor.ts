// Marketr — Wave 2 Insurance slice 1: vendor rail interface + mock fixtures.
//
// CoverForce is the primary rail (SPEC-INSURANCE.md §3.4); Bold Penguin DeX ai
// is staged as the agentic second rail later. This file defines the adapter
// interface every rail implements and a mock CoverForce adapter backed by
// fixture data — no live vendor calls until the Startup Program paperwork is
// signed. Slice 2 wires the quoting methods against fixtures.
//
// Producer-of-record (Tico 2026-10-01): LICENSED PARTNER model. bind()
// requires an appointed partner's id; without one it fails closed with
// PARTNER_NOT_APPOINTED — never a silent skip.

import type {
  InsuranceAppointmentPath,
  InsuranceLineOfBusiness,
  InsurancePolicyStatus,
} from "./types";

export interface VendorCarrierFixture {
  name: string;
  amBestRating: string;
  naicCode: string;
  appointmentPath: InsuranceAppointmentPath;
  linesSupported: InsuranceLineOfBusiness[];
}

export interface VendorPolicyFixture {
  policyNumber: string;
  carrierName: string;
  line: InsuranceLineOfBusiness;
  namedInsured: string;
  effectiveAt: string;
  expiresAt: string;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  deductibleCents: number | null;
  annualPremiumCents: number | null;
  paymentSchedule: string | null;
  status: InsurancePolicyStatus;
}

// Slice 3b — bind execution surface (SPEC-INSURANCE.md §5).
export interface VendorBindInput {
  /** Our quote row id (the vendor's quoteRef is carried in the quote's rawPayload). */
  quoteId: string;
  /** Appointed licensed partner's id — REQUIRED (LICENSED PARTNER model). */
  partnerId: string;
  /** Idempotency key derived from (quoteId, approvalId); replays must not double-bind. */
  idempotencyKey: string;
}

export interface VendorBindResult {
  policyNumber: string;
  /** ISO date/datetime the carrier bound coverage from. */
  effectiveDate: string;
  /** The carrier's confirmation reference for the bind transaction. */
  carrierConfirmation: string;
  /** Bound premium in cents, from the carrier. Null = "not confirmed". */
  premiumCents: number | null;
  /** The vendor rail's carrier-direct payment reference (zero custody). */
  paymentReference: string;
}

export interface VendorIssuePolicyResult {
  policyId: string;
}

/**
 * The vendor adapter every rail implements. Designed so Bold Penguin's DeX ai
 * MCP surface (or any A2A surface) can replace or sit alongside the
 * CoverForce REST shim without rewriting agent logic (SPEC-INSURANCE.md §5).
 */
export interface InsuranceVendor {
  readonly name: "coverforce" | "bold_penguin" | "mock";
  /** Real-time carrier appetite for a line + class code. */
  checkAppetite(input: {
    line: InsuranceLineOfBusiness;
    classCode?: string;
    state?: string;
  }): Promise<{ carriers: string[]; notes: string }>;
  /** Submit a risk packet; returns the vendor's submission reference. */
  submit(input: {
    line: InsuranceLineOfBusiness;
    applicantName: string;
    state: string;
    payrollCents?: number | null;
    revenueCents?: number | null;
  }): Promise<{ submissionRef: string }>;
  /** Quotes for a submission. Declines are first-class with reasons. */
  getQuotes(input: {
    submissionRef: string;
  }): Promise<
    Array<{
      carrierName: string;
      quotedPremiumCents: number | null;
      limitPerOccurrenceCents: number | null;
      limitAggregateCents: number | null;
      quoteExpiry: string;
      status: "quoted" | "declined" | "referred";
      declineReason?: string;
    }>
  >;
  /** Bind a quoted offer. FAIL-CLOSED: requires an appointed licensed
   *  partner's id (LICENSED PARTNER model, Tico 2026-10-01). Without one,
   *  throws PARTNER_NOT_APPOINTED — never a silent skip. The idempotency
   *  key makes replays safe: the same key must never produce two policies. */
  bind(input: VendorBindInput): Promise<VendorBindResult>;
  /** Issue a bound policy's documents/issuance record. v1: may delegate to bind. */
  issuePolicy(input: { quoteId: string; partnerId: string }): Promise<VendorIssuePolicyResult>;
  /** Policy documents for an issued policy. */
  getPolicyDocuments(input: {
    policyNumber: string;
  }): Promise<{ documents: Array<{ kind: string; url: string }> }>;
}

export class InsuranceVendorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InsuranceVendorError";
    this.code = code;
  }
}

/**
 * Deterministic fixture refs: the same idempotency key always yields the
 * same policy number / confirmation / payment reference, so replays are
 * visibly idempotent even at the adapter level. FNV-1a, 8 hex chars.
 */
export function fixtureRef(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function requirePartnerId(partnerId: string): void {
  if (!partnerId || partnerId.trim().length === 0) {
    // Fail closed: LICENSED PARTNER model — no appointed partner, no bind.
    throw new InsuranceVendorError(
      "PARTNER_NOT_APPOINTED",
      "Binding is blocked: no appointed licensed partner was provided. " +
        "Register a licensed partner (producer license number + licensed " +
        "states) before binding.",
    );
  }
}

// ---------------------------------------------------------------------------
// Mock CoverForce adapter: fixture carriers + policies for the dashboard and
// for adapter contract tests. Quoting/bind methods return fixtures; bind is
// intentionally NOT callable in tests without the license-model gate.
// ---------------------------------------------------------------------------

export const MOCK_CARRIERS: VendorCarrierFixture[] = [
  {
    name: "AmTrust",
    amBestRating: "A",
    naicCode: "15954",
    appointmentPath: "dais_market_access",
    linesSupported: ["wc", "gl", "bop"],
  },
  {
    name: "Chubb",
    amBestRating: "A++",
    naicCode: "10052",
    appointmentPath: "dais_market_access",
    linesSupported: ["gl", "bop", "cyber", "professional_liability", "umbrella"],
  },
  {
    name: "Travelers",
    amBestRating: "A++",
    naicCode: "25658",
    appointmentPath: "dais_market_access",
    linesSupported: ["gl", "wc", "bop", "commercial_auto", "umbrella"],
  },
];

export const MOCK_POLICIES: VendorPolicyFixture[] = [
  {
    policyNumber: "GL-2026-004812",
    carrierName: "Chubb",
    line: "gl",
    namedInsured: "Acme Landscaping LLC",
    effectiveAt: "2026-01-15T00:00:00.000Z",
    expiresAt: "2027-01-15T00:00:00.000Z",
    limitPerOccurrenceCents: 100_000_000,
    limitAggregateCents: 200_000_000,
    deductibleCents: 100_000,
    annualPremiumCents: 485_000,
    paymentSchedule: "quarterly",
    status: "active",
  },
  {
    policyNumber: "WC-2025-118833",
    carrierName: "AmTrust",
    line: "wc",
    namedInsured: "Acme Landscaping LLC",
    effectiveAt: "2025-11-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    limitPerOccurrenceCents: null,
    limitAggregateCents: null,
    deductibleCents: null,
    annualPremiumCents: 912_000,
    paymentSchedule: "monthly",
    status: "pending_renewal",
  },
  {
    policyNumber: "BOP-2024-009211",
    carrierName: "Travelers",
    line: "bop",
    namedInsured: "Acme Landscaping LLC",
    effectiveAt: "2024-06-01T00:00:00.000Z",
    expiresAt: "2025-06-01T00:00:00.000Z",
    limitPerOccurrenceCents: 100_000_000,
    limitAggregateCents: 200_000_000,
    deductibleCents: 250_000,
    annualPremiumCents: 312_000,
    paymentSchedule: "annual",
    status: "expired",
  },
];

export class MockCoverForceVendor implements InsuranceVendor {
  readonly name = "mock" as const;

  async checkAppetite(input: {
    line: InsuranceLineOfBusiness;
    classCode?: string;
    state?: string;
  }): Promise<{ carriers: string[]; notes: string }> {
    const carriers = MOCK_CARRIERS.filter((c) =>
      c.linesSupported.includes(input.line),
    ).map((c) => c.name);
    return {
      carriers,
      notes:
        carriers.length > 0
          ? `Fixture appetite for ${input.line}${input.state ? ` in ${input.state}` : ""}.`
          : `No fixture carrier writes ${input.line}.`,
    };
  }

  async submit(input: {
    line: InsuranceLineOfBusiness;
    applicantName: string;
    state: string;
    payrollCents?: number | null;
    revenueCents?: number | null;
  }): Promise<{ submissionRef: string }> {
    if (!input.applicantName.trim()) {
      throw new InsuranceVendorError("APPLICANT_REQUIRED", "Applicant name is required.");
    }
    return { submissionRef: `MOCK-SUB-${Date.now().toString(36).toUpperCase()}` };
  }

  async getQuotes(input: { submissionRef: string }): Promise<
    Array<{
      carrierName: string;
      quotedPremiumCents: number | null;
      limitPerOccurrenceCents: number | null;
      limitAggregateCents: number | null;
      quoteExpiry: string;
      status: "quoted" | "declined" | "referred";
      declineReason?: string;
    }>
  > {
    void input;
    return [
      {
        carrierName: "Chubb",
        quotedPremiumCents: 512_000,
        limitPerOccurrenceCents: 100_000_000,
        limitAggregateCents: 200_000_000,
        quoteExpiry: new Date(Date.now() + 30 * 86400_000).toISOString(),
        status: "quoted",
      },
      {
        carrierName: "Travelers",
        quotedPremiumCents: 468_000,
        limitPerOccurrenceCents: 100_000_000,
        limitAggregateCents: 200_000_000,
        quoteExpiry: new Date(Date.now() + 30 * 86400_000).toISOString(),
        status: "quoted",
      },
      {
        carrierName: "AmTrust",
        quotedPremiumCents: null,
        limitPerOccurrenceCents: null,
        limitAggregateCents: null,
        quoteExpiry: new Date(Date.now() + 30 * 86400_000).toISOString(),
        status: "declined",
        declineReason: "Class code outside current appetite (fixture).",
      },
    ];
  }

  async bind(input: VendorBindInput): Promise<VendorBindResult> {
    requirePartnerId(input.partnerId);
    if (!input.quoteId || input.quoteId.trim().length === 0) {
      throw new InsuranceVendorError("QUOTE_REF_REQUIRED", "bind requires a quote id.");
    }
    if (!input.idempotencyKey || input.idempotencyKey.trim().length === 0) {
      throw new InsuranceVendorError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "bind requires an idempotency key derived from (quoteId, approvalId).",
      );
    }
    // Fixture data, deterministic per idempotency key — clearly labeled, and
    // the same key can never mint two different policies at this layer.
    // premiumCents is a deterministic fixture premium (the mock has no quote
    // context); live mode returns the carrier's real bound premium.
    const tag = fixtureRef(input.idempotencyKey);
    return {
      policyNumber: `MOCK-POL-${tag}`,
      effectiveDate: new Date().toISOString(),
      carrierConfirmation: `MOCK-CONF-${fixtureRef(`${input.idempotencyKey}:confirm`)}`,
      premiumCents: 400_000 + (parseInt(tag.slice(2, 6), 16) % 300_000),
      paymentReference: `MOCK-PAY-${fixtureRef(`${input.idempotencyKey}:pay`)}`,
    };
  }

  async issuePolicy(input: {
    quoteId: string;
    partnerId: string;
  }): Promise<VendorIssuePolicyResult> {
    requirePartnerId(input.partnerId);
    if (!input.quoteId || input.quoteId.trim().length === 0) {
      throw new InsuranceVendorError("QUOTE_REF_REQUIRED", "issuePolicy requires a quote id.");
    }
    // v1: issuance delegates to bind; the issued-policy id is derived from
    // the bound policy number (fixture-labeled).
    const bound = await this.bind({
      quoteId: input.quoteId,
      partnerId: input.partnerId,
      idempotencyKey: `issue:${input.quoteId}:${input.partnerId}`,
    });
    return { policyId: `MOCK-ISSUED-${bound.policyNumber}` };
  }

  async getPolicyDocuments(input: {
    policyNumber: string;
  }): Promise<{ documents: Array<{ kind: string; url: string }> }> {
    void input;
    return {
      documents: [
        { kind: "declarations", url: "mock://documents/declarations.pdf" },
        { kind: "policy_jacket", url: "mock://documents/policy_jacket.pdf" },
      ],
    };
  }
}
