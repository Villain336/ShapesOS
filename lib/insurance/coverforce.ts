// Marketr — Wave 2 Insurance slice 2: CoverForce vendor adapter.
//
// CoverForce is the primary rail (SPEC-INSURANCE.md §3.4): API-first,
// Startup Program + Amwins DAIS market access. This adapter implements the
// InsuranceVendor interface so Bold Penguin's DeX ai MCP surface can replace
// or sit alongside it later without rewriting agent logic.
//
// Until the Startup Program paperwork is signed there are no live
// credentials: the adapter runs in fixture mode (clearly labeled) and any
// attempt to switch to live fails closed with VENDOR_NOT_CONFIGURED.
// bind() requires an appointed licensed partner id (LICENSED PARTNER model,
// Tico 2026-10-01) and fails closed with PARTNER_NOT_APPOINTED without one.

import {
  InsuranceVendorError,
  MockCoverForceVendor,
  type InsuranceVendor,
  type VendorBindInput,
  type VendorBindResult,
  type VendorIssuePolicyResult,
} from "./mock-vendor";
import type { InsuranceLineOfBusiness } from "./types";

export type CoverForceMode = "fixture" | "live";

export interface CoverForceConfig {
  mode: CoverForceMode;
  /** Required for live mode. Never logged, never echoed. */
  apiKey?: string;
  baseUrl?: string;
}

export class CoverForceVendor implements InsuranceVendor {
  readonly name = "coverforce" as const;
  private readonly mode: CoverForceMode;
  private readonly fixtures = new MockCoverForceVendor();

  constructor(config: CoverForceConfig = { mode: "fixture" }) {
    this.mode = config.mode;
    if (config.mode === "live" && !config.apiKey) {
      throw new InsuranceVendorError(
        "VENDOR_NOT_CONFIGURED",
        "CoverForce live mode requires API credentials from the Startup Program. " +
          "No live calls are made without them.",
      );
    }
  }

  /** True only when real carrier data backs the responses. */
  get isLive(): boolean {
    return this.mode === "live";
  }

  private requireLive(caller: string): never {
    throw new InsuranceVendorError(
      "VENDOR_NOT_CONFIGURED",
      `CoverForce.${caller} needs live credentials (Startup Program paperwork ` +
        `unsigned). Running in fixture mode instead — responses are labeled fixtures.`,
    );
  }

  async checkAppetite(input: {
    line: InsuranceLineOfBusiness;
    classCode?: string;
    state?: string;
  }): Promise<{ carriers: string[]; notes: string }> {
    if (this.mode === "live") this.requireLive("checkAppetite");
    const result = await this.fixtures.checkAppetite(input);
    return { ...result, notes: `[fixture] ${result.notes}` };
  }

  async submit(input: {
    line: InsuranceLineOfBusiness;
    applicantName: string;
    state: string;
    payrollCents?: number | null;
    revenueCents?: number | null;
  }): Promise<{ submissionRef: string }> {
    if (this.mode === "live") this.requireLive("submit");
    return this.fixtures.submit(input);
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
    if (this.mode === "live") this.requireLive("getQuotes");
    return this.fixtures.getQuotes(input);
  }

  async bind(input: VendorBindInput): Promise<VendorBindResult> {
    if (!input.partnerId || input.partnerId.trim().length === 0) {
      // Fail closed regardless of mode: LICENSED PARTNER model — the
      // partner holds the licenses, Marketr provides the software.
      throw new InsuranceVendorError(
        "PARTNER_NOT_APPOINTED",
        "Binding is blocked: no appointed licensed partner was provided. " +
          "Register a licensed partner (producer license number + licensed " +
          "states) before binding.",
      );
    }
    if (this.mode === "live") this.requireLive("bind");
    return this.fixtures.bind(input);
  }

  async issuePolicy(input: {
    quoteId: string;
    partnerId: string;
  }): Promise<VendorIssuePolicyResult> {
    if (!input.partnerId || input.partnerId.trim().length === 0) {
      throw new InsuranceVendorError(
        "PARTNER_NOT_APPOINTED",
        "Issuance is blocked: no appointed licensed partner was provided.",
      );
    }
    if (this.mode === "live") this.requireLive("issuePolicy");
    // v1: issuance delegates to bind (same as the fixture adapter).
    return this.fixtures.issuePolicy(input);
  }

  async getPolicyDocuments(input: {
    policyNumber: string;
  }): Promise<{ documents: Array<{ kind: string; url: string }> }> {
    if (this.mode === "live") this.requireLive("getPolicyDocuments");
    return this.fixtures.getPolicyDocuments(input);
  }
}
