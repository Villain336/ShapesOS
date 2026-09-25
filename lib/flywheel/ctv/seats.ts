// Marketr — Phase 7 F4: bring-your-own-seat adapters.
//
// TTD (OpenTTD), DV360 (API v4), Amazon DSP, Basis. These are gated DSPs:
// without an agency seat there is NOTHING to call. Adapters FAIL CLOSED
// without a seat and return "connect your agency seat" setup guidance —
// they never promise "one-click TTD" to a customer without a seat.
// Same approval-object gating as Vibe: any spend action requires a
// Phase 5 per-buy approval object id.
//
// Zero-custody (spec §3.3 / invariant 13): DSP contracts and billing sit
// with the agency/client entity — never Marketr. Marketr is orchestration,
// approval, kill-switching, and margin accounting.

import type { CtvStore } from "./store";

export const SEAT_DSPS = ["ttd", "dv360", "amazon", "basis"] as const;
export type SeatDsp = (typeof SEAT_DSPS)[number];

export type SeatStatus = "none" | "pending" | "connected";

export interface SeatGuidance {
  dsp: SeatDsp;
  label: string;
  status: SeatStatus;
  /** What the agency needs to bring. */
  requirements: string[];
  setupSteps: string[];
  docsUrl: string;
  custodyNote: string;
}

const SEAT_REGISTRY: Record<SeatDsp, Omit<SeatGuidance, "status">> = {
  ttd: {
    dsp: "ttd",
    label: "The Trade Desk (OpenTTD)",
    requirements: [
      "A direct TTD seat or partner-routed access via your agency",
      "OpenTTD API credentials issued against that seat",
      "Aggregate spend that justifies the seat (see the DSP tripwire: >$250K/mo sustained for direct)",
    ],
    setupSteps: [
      "Confirm your TTD seat or partner agreement is active",
      "Generate OpenTTD API credentials in the TTD UI",
      "Store them in the Secure Vault (Settings → Flywheel → DSP seats) — never in chat or code",
      "Status flips to connected; campaigns become pausable through Marketr",
    ],
    docsUrl: "https://partner.thetradedesk.com/",
    custodyNote: "Your TTD contract and billing stay with your agency — Marketr never holds or fronts spend.",
  },
  dv360: {
    dsp: "dv360",
    label: "DV360 (Display & Video 360 API v4)",
    requirements: [
      "A DV360 partner/reseller seat (Google Marketing Platform)",
      "A Google Cloud project with the DV360 API enabled + OAuth consent",
      "Service-account or OAuth credentials scoped to your seat",
    ],
    setupSteps: [
      "Confirm DV360 seat access via your GMP reseller or direct agreement",
      "Enable the DV360 API (v4) on your Google Cloud project",
      "Store the OAuth/service-account credentials in the Secure Vault",
      "Status flips to connected; kill-switches become real pause calls",
    ],
    docsUrl: "https://developers.google.com/display-video/api",
    custodyNote: "Your Google/DV360 billing stays with your agency — Marketr never holds or fronts spend.",
  },
  amazon: {
    dsp: "amazon",
    label: "Amazon DSP",
    requirements: [
      "Amazon DSP access: managed via Amazon or an agency seat (self-service has eligibility minimums)",
      "Amazon Ads API credentials (certification/seat required)",
    ],
    setupSteps: [
      "Confirm Amazon DSP eligibility or agency-seat access with your Amazon rep",
      "Complete the Amazon Ads API onboarding for your seat",
      "Store the credentials in the Secure Vault",
      "Status flips to connected",
    ],
    docsUrl: "https://advertising.amazon.com/API/docs",
    custodyNote: "Your Amazon billing stays with your agency — Marketr never holds or fronts spend.",
  },
  basis: {
    dsp: "basis",
    label: "Basis (Centro)",
    requirements: [
      "An active Basis platform seat via your agency agreement",
      "Basis API credentials issued against that seat",
    ],
    setupSteps: [
      "Confirm your Basis seat is active",
      "Generate API credentials in Basis",
      "Store them in the Secure Vault",
      "Status flips to connected",
    ],
    docsUrl: "https://www.basis.net/",
    custodyNote: "Your Basis contract and billing stay with your agency — Marketr never holds or fronts spend.",
  },
};

export class SeatNotConnectedError extends Error {
  readonly code = "seat_not_connected";
  readonly dsp: SeatDsp;
  constructor(dsp: SeatDsp) {
    const g = SEAT_REGISTRY[dsp];
    super(
      `${g.label} is not connected: no agency seat is linked. ` +
      `Connect your agency seat (Settings → Flywheel → DSP seats) to enable pausing and reporting here. ` +
      `Requirements: ${g.requirements.join("; ")}.`,
    );
    this.name = "SeatNotConnectedError";
    this.dsp = dsp;
  }
}

export function seatStatusFromEnv(dsp: SeatDsp, env: NodeJS.ProcessEnv = process.env): SeatStatus {
  const key = { ttd: "TTD_SEAT_REF", dv360: "DV360_SEAT_REF", amazon: "AMAZON_DSP_SEAT_REF", basis: "BASIS_SEAT_REF" }[dsp];
  const ref = env[key];
  if (!ref) return "none";
  if (ref === "pending") return "pending";
  return "connected";
}

export function seatGuidance(dsp: SeatDsp, status: SeatStatus): SeatGuidance {
  return { ...SEAT_REGISTRY[dsp], status };
}

/**
 * Fail-closed adapter shell. Read-only metadata (guidance) is available
 * without a seat; EVERY spend/mutation action throws SeatNotConnectedError
 * unless status === "connected". Same approval-object gating as Vibe.
 */
export class SeatAdapter {
  constructor(
    private dsp: SeatDsp,
    private store: CtvStore,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  get status(): SeatStatus {
    return seatStatusFromEnv(this.dsp, this.env);
  }

  guidance(): SeatGuidance {
    return seatGuidance(this.dsp, this.status);
  }

  private requireSeat(): void {
    if (this.status !== "connected") throw new SeatNotConnectedError(this.dsp);
  }

  private requireApproval(approvalObjectId: string | undefined, what: string): void {
    if (!approvalObjectId) {
      throw new Error(`${SEAT_REGISTRY[this.dsp].label} ${what} refused: a Phase 5 per-buy approval object id is required`);
    }
  }

  /**
   * Pause a campaign through the seat. FAILS CLOSED without a connected
   * seat — returns the setup guidance, performs nothing.
   */
  async pauseCampaign(opts: {
    workspaceId: string; actor: string; externalCampaignId: string; approvalObjectId: string;
  }): Promise<{ paused: boolean; dsp: SeatDsp }> {
    this.requireApproval(opts.approvalObjectId, "pauseCampaign");
    if (this.status !== "connected") {
      await this.store.audit({
        workspaceId: opts.workspaceId, actor: opts.actor,
        action: "seat_action_rejected", subjectType: "adapter", subjectId: `seat:${this.dsp}`,
        detail: { reason: "no_seat", externalCampaignId: opts.externalCampaignId },
      });
      throw new SeatNotConnectedError(this.dsp);
    }
    // v1: seat plumbing validated; live pause calls land here once a seat's
    // SDK is vendored (F5). Fail closed until then — never a fake pause.
    throw new Error(
      `${SEAT_REGISTRY[this.dsp].label}: seat is marked connected but the v1 seat SDK is not vendored yet. ` +
      "No pause was executed. This is a readiness rail, not a live control — pause in the DSP UI.",
    );
  }

  async reportStatus(workspaceId: string, actor: string): Promise<{ dsp: SeatDsp; status: SeatStatus; guidance: SeatGuidance }> {
    await this.store.audit({
      workspaceId, actor, action: "seat_status_checked",
      subjectType: "adapter", subjectId: `seat:${this.dsp}`,
      detail: { status: this.status },
    });
    return { dsp: this.dsp, status: this.status, guidance: this.guidance() };
  }
}

export function createSeatAdapter(dsp: SeatDsp, store: CtvStore, env?: NodeJS.ProcessEnv): SeatAdapter {
  return new SeatAdapter(dsp, store, env);
}
