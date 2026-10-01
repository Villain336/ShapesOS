// Shared serializer + error mapping for the insurance renewals API
// (Wave 2 Insurance slice 4).

import { httpErrorResponse } from "@/lib/enrichment/guard";
import {
  LINE_LABELS,
  daysUntilRenewal,
  deltaExceedsThreshold,
  renewalAlertLevel,
  InsuranceError,
  type InsuranceLineOfBusiness,
  type InsuranceRemarketStatus,
  type RenewalAlertLevel,
} from "@/lib/insurance/types";
import type { RenewalRecord } from "@/lib/insurance/renewals";

export const REMARKET_STATUS_LABELS: Record<InsuranceRemarketStatus, string> = {
  detected: "Detected",
  remarketing: "Remarketing",
  quoted: "Quoted",
  bound: "Bound",
  auto_renew_surfaced: "Auto-renew surfaced",
};

/** Named domain error codes → HTTP status. */
export function renewalDomainStatus(code: string): number {
  if (code === "RENEWAL_NOT_FOUND") return 404;
  return 422;
}

export function renewalErrorResponse(e: unknown): Response {
  if (e instanceof InsuranceError) {
    return Response.json(
      { error: e.message, code: e.code },
      { status: renewalDomainStatus(e.code) },
    );
  }
  return httpErrorResponse(e);
}

export interface SerializedRenewal {
  id: string;
  renewalDate: string;
  daysUntilRenewal: number;
  alertLevel: RenewalAlertLevel;
  remarketStatus: InsuranceRemarketStatus;
  statusLabel: string;
  policyNumber: string | null;
  line: string | null;
  lineLabel: string | null;
  carrierName: string | null;
  namedInsured: string | null;
  expiresAt: string | null;
  priorPremiumCents: number | null;
  newPremiumCents: number | null;
  premiumDeltaPct: number | null;
  /** True when the premium moved more than the flag threshold — the agent
   *  must surface this before any renewal approval. */
  deltaFlagged: boolean;
  /** True for surfaced auto-renews and flagged deltas. */
  needsReview: boolean;
  autoRenewTerms: unknown;
}

export function serializeRenewal(r: RenewalRecord): SerializedRenewal {
  const prior =
    r.priorPremiumCents ?? r.policy?.annualPremiumCents ?? null;
  const deltaFlagged =
    prior != null &&
    prior > 0 &&
    r.newPremiumCents != null &&
    deltaExceedsThreshold(prior, r.newPremiumCents);
  const needsReview =
    r.remarketStatus === "auto_renew_surfaced" || deltaFlagged;
  return {
    id: r.id,
    renewalDate: r.renewalDate.toISOString(),
    daysUntilRenewal: daysUntilRenewal(r.renewalDate),
    alertLevel: renewalAlertLevel(r.renewalDate),
    remarketStatus: r.remarketStatus,
    statusLabel: REMARKET_STATUS_LABELS[r.remarketStatus],
    policyNumber: r.policy?.policyNumber ?? null,
    line: r.policy?.line ?? null,
    lineLabel: r.policy
      ? LINE_LABELS[r.policy.line as InsuranceLineOfBusiness]
      : null,
    carrierName: r.policy?.carrierName ?? null,
    namedInsured: r.policy?.namedInsured ?? null,
    expiresAt: r.policy?.expiresAt.toISOString() ?? null,
    priorPremiumCents: prior,
    newPremiumCents: r.newPremiumCents,
    premiumDeltaPct: r.premiumDeltaPct,
    deltaFlagged,
    needsReview,
    autoRenewTerms: r.autoRenewTerms ?? null,
  };
}
