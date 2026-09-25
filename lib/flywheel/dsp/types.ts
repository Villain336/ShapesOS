// Marketr — Phase 7 F5: DSP readiness (no seat in v1).
//
// Seat-agnostic campaign/line-item model + DSP plug-in adapter interface.
// Structural rules (SPEC-PHASE7 §1.8, §9.13):
//   - DSP contracts and billing sit with the agency/client entity — NEVER
//     Marketr. Zero custody. No type in this namespace may hold a client
//     payment instrument (no PANs, no tokens, no credentials inline).
//   - Adapters fail CLOSED without a connected seat: every operation throws
//     SeatNotConnectedError carrying "connect your agency seat" guidance.

export type DspKind = "ttd" | "dv360" | "amazon" | "basis";

export const DSP_KINDS: DspKind[] = ["ttd", "dv360", "amazon", "basis"];

export const DSP_LABELS: Record<DspKind, string> = {
  ttd: "The Trade Desk",
  dv360: "DV360 (Google)",
  amazon: "Amazon DSP",
  basis: "Basis",
};

export type SeatStatus = "none" | "pending" | "connected";

/**
 * Seat-agnostic campaign. A DSP campaign/line item is one internal model;
 * the DSP is a plug-in behind DspAdapter. spend/cap fields are caps only —
 * the money itself never passes through Marketr (zero custody).
 */
export interface DspCampaign {
  id: string;
  workspaceId: string;
  name: string;
  dsp: DspKind;
  /** Platform-native campaign/line-item reference (opaque string from the DSP). */
  platformRef: string;
  capCents: number;
  status: "draft" | "live" | "paused" | "ended";
  flightFrom: Date;
  flightTo: Date;
  /** Approval that backs this campaign's cap (Phase 5 approval object id). */
  approvalId: string;
  createdAt: Date;
}

export interface DspLineItem {
  id: string;
  campaignId: string;
  workspaceId: string;
  name: string;
  platformRef: string;
  capCents: number;
  status: "draft" | "live" | "paused" | "ended";
}

/** Opaque vault reference to seat credentials. NEVER credential material. */
export type SeatConfigRef = string;

/**
 * The stable internal interface every DSP adapter implements. All mutating
 * ops fail closed (SeatNotConnectedError) when there is no connected seat —
 * they never pretend to pause a buy Marketr cannot reach.
 */
export interface DspAdapter {
  readonly kind: DspKind;
  readonly seatStatus: SeatStatus;
  /** Pause a campaign/line-item. Real pause where a seat exists. */
  pause(opts: { platformRef: string; reason: string; actor: string }): Promise<DspOpResult>;
  /** Enforce a budget cap (from a human-signed approval object). */
  setCap(opts: { platformRef: string; capCents: number; approvalId: string }): Promise<DspOpResult>;
  /** Read-only reporting (spend, impressions, caps). */
  report(opts: { platformRef: string }): Promise<DspReportResult>;
}

export interface DspOpResult {
  executed: boolean;
  platformRef: string;
  /** "paused" | "cap_set" | "not_connected" | "not_supported" */
  outcome: "paused" | "cap_set" | "not_connected" | "not_supported";
  detail: string;
}

export interface DspReportResult {
  platformRef: string;
  spendCents: number;
  impressions: number;
  capCents: number | null;
  currency: string;
}

export class SeatNotConnectedError extends Error {
  readonly dsp: DspKind;
  readonly guidance: string;
  constructor(dsp: DspKind) {
    const label = DSP_LABELS[dsp];
    const guidance =
      `No ${label} seat connected. Marketr cannot pause, cap, or report on ${label} ` +
      `campaigns without your agency's own seat. Connect your agency seat: ` +
      `Settings → Flywheel → DSP seat configs → ${label} (bring your own seat; ` +
      `contracts and billing stay with your agency — never Marketr).`;
    super(guidance);
    this.name = "SeatNotConnectedError";
    this.dsp = dsp;
    this.guidance = guidance;
  }
}

/** Zero-custody contract: this namespace holds NO payment instruments. */
export const ZERO_CUSTODY_COPY =
  "DSP contracts and billing sit with the agency/client entity — never Marketr. " +
  "Marketr orchestrates, approves, kill-switches, and accounts. It never holds, " +
  "fronts, or co-mingles client funds.";

export function assertDspKind(v: string): asserts v is DspKind {
  if (!(DSP_KINDS as string[]).includes(v)) {
    throw new Error(`Unknown DSP kind "${v}". Expected one of: ${DSP_KINDS.join(", ")}.`);
  }
}

export function assertSeatStatus(v: string): asserts v is SeatStatus {
  if (!["none", "pending", "connected"].includes(v)) {
    throw new Error(`Invalid seat status "${v}". Expected none|pending|connected.`);
  }
}
