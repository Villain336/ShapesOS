// Marketr — Connector Agent slice 5: Modes + Funding/VC plug-in.
// SPEC-CONNECTOR-AGENT.md §2/§5/§6.
//
// The connector runs in one of two operating modes:
//
// - LEADS   — customer/partner intros. Targets are connector Companies
//             with relationship customer / prospect / partner.
// - FUNDING — investor intros. Targets are the Funding/VC investor CRM
//             (FundingInvestor rows — read-only here, never duplicated)
//             plus connector Companies with relationship investor.
//
// Mode lives in two places: a tenant-level preference (ConnectorSetting,
// the LEADS/FUNDING switch on /dashboard/connector) and per-query /
// per-proposal overrides (path-finding + propose_intro accept an explicit
// mode). LEADS-mode proposals never touch funding rows.

import { ConnectorError } from "./types";
import type { InvestorStage } from "../funding/types";

export const CONNECTOR_MODES = ["leads", "funding"] as const;
export type ConnectorMode = (typeof CONNECTOR_MODES)[number];

export function isConnectorMode(value: unknown): value is ConnectorMode {
  return (
    typeof value === "string" &&
    (CONNECTOR_MODES as readonly string[]).includes(value)
  );
}

/** Pure validation for mode inputs (settings + per-query overrides). */
export function validateConnectorMode(input: unknown): {
  errors: string[];
  value: ConnectorMode | null;
} {
  if (input == null || (typeof input === "string" && !input.trim())) {
    return { errors: [], value: null }; // absent = "use the tenant setting"
  }
  if (isConnectorMode((input as string).trim().toLowerCase())) {
    return { errors: [], value: (input as string).trim().toLowerCase() as ConnectorMode };
  }
  return {
    errors: [`mode must be one of: ${CONNECTOR_MODES.join(", ")}. Got: ${String(input)}`],
    value: null,
  };
}

/** Default when the tenant has never set a mode: LEADS. */
export const DEFAULT_CONNECTOR_MODE: ConnectorMode = "leads";

/** Company relationships that are legal intro targets in each mode. */
export const LEADS_TARGET_RELATIONSHIPS = [
  "customer",
  "prospect",
  "partner",
] as const;
export type LeadsTargetRelationship = (typeof LEADS_TARGET_RELATIONSHIPS)[number];

export const FUNDING_TARGET_RELATIONSHIPS = ["investor"] as const;
export type FundingTargetRelationship = (typeof FUNDING_TARGET_RELATIONSHIPS)[number];

/** Mode-scoped company-target filter. Pure — tested directly. */
export function companyRelationshipAllowedInMode(
  relationship: string | null,
  mode: ConnectorMode,
): boolean {
  if (!relationship) return false;
  if (mode === "funding") {
    return (FUNDING_TARGET_RELATIONSHIPS as readonly string[]).includes(relationship);
  }
  return (LEADS_TARGET_RELATIONSHIPS as readonly string[]).includes(relationship);
}

/**
 * The mode rule for proposals: a proposal carrying a fundingInvestorId is
 * only legal in FUNDING mode; FUNDING mode never REQUIRES one (the intro
 * can target any network person — the link is the writeback hook, not a
 * gate). Pure — tested directly.
 */
export function assertProposalModeLaw(opts: {
  mode: ConnectorMode;
  fundingInvestorId: string | null;
}): void {
  if (opts.fundingInvestorId && opts.mode !== "funding") {
    throw new ConnectorError(
      "mode_mismatch",
      "fundingInvestorId is only legal in FUNDING mode — this proposal is LEADS.",
    );
  }
}

// ---------------------------------------------------------------------------
// View types.
// ---------------------------------------------------------------------------

export interface ConnectorSettingView {
  mode: ConnectorMode;
  updatedAt: Date;
}

/**
 * Read-only projection of a FundingInvestor for FUNDING-mode target
 * picking. The connector never duplicates investor data — it reads the
 * CRM rows and links introductions N:1 to them.
 */
export interface FundingInvestorTargetView {
  id: string;
  name: string;
  firm: string | null;
  title: string | null;
  email: string | null;
  checkSizeMin: number | null;
  checkSizeMax: number | null;
  stages: string[];
  sectors: string[];
  thesisFit: string | null;
  stage: InvestorStage;
}

/** Mode-scoped target list served to the UI's path-finding pickers. */
export interface ModeTargetListView {
  /** The mode that was applied (request override or tenant setting). */
  mode: ConnectorMode;
  /** Connector companies legal in this mode. */
  companies: Array<{
    id: string;
    name: string;
    industry: string | null;
    sizeBand: string | null;
    relationship: string | null;
    employeeCount: number;
  }>;
  /** FUNDING mode only: investor CRM targets (read-only). Empty in LEADS. */
  investors: FundingInvestorTargetView[];
}
