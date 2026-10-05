// Marketr — Phase 7 F4: concierge IO workflow.
//
// For MNTN, Roku Ads Manager, Tatari, tvScientific: Marketr generates the
// IO + creative brief (audience, geo, budget, flight, spec sheet); the HUMAN
// places the buy in the vendor UI. States:
//   draft → pending_vendor_approval → human_placed → live → reconciling
// "pending_vendor_approval" is first-class: managed services add days, buys
// are not instant.
//
// ALERT-ONLY (invariant 12): Marketr cannot pause these buys. A pause
// request produces an alert for the human with explicit UI copy —
// "Marketr cannot pause this buy — alerts only." — and NO state change,
// NO fake pause call.
//
// Honesty notes (spec §2/F4, surfaced in-product):
// - MNTN minimums conflict in 2026 sources (site says "no minimums", third
//   parties report $5K–$25K tiers) — flagged for verification at IO time.
// - 2026 forensic-audit allegations about MNTN supply paths exist — Marketr
//   does NOT repeat "direct premium" claims as its own.

import type { CtvIoRow, CtvIoState, CtvStore } from "./store";
import type { CreativeValidation } from "./validator";

/** Canonical alert-only copy. Enforced in UI + API responses. */
export const CONCIERGE_ALERT_ONLY_COPY =
  "ShapesOS cannot pause this buy — alerts only. Pause it in the vendor's UI, then mark it paused here.";

export const CONCIERGE_VENDORS = ["mntn", "roku", "tatari", "tvscientific"] as const;
export type ConciergeVendor = (typeof CONCIERGE_VENDORS)[number];

export interface ConciergeVendorNote {
  vendor: ConciergeVendor;
  label: string;
  honestyNotes: string[];
  typicalLeadTime: string;
}

export const CONCIERGE_VENDOR_NOTES: ConciergeVendorNote[] = [
  {
    vendor: "mntn",
    label: "MNTN",
    honestyNotes: [
      "Minimums conflict in 2026 sources: MNTN's site says no minimums; third parties report $5K–$25K tiers. Verify the current minimum with your rep at IO time.",
      "2026 forensic-audit allegations about MNTN supply paths have been reported. ShapesOS does not endorse vendor supply-quality claims as its own — evaluate independently.",
    ],
    typicalLeadTime: "Managed buys commonly need 3–7 business days before first air.",
  },
  {
    vendor: "roku",
    label: "Roku Ads Manager",
    honestyNotes: ["Self-serve; you place the buy yourself in Roku Ads Manager. ShapesOS prepares the IO and brief, nothing else."],
    typicalLeadTime: "Self-serve — live once you click through; creative review can add 1–2 days.",
  },
  {
    vendor: "tatari",
    label: "Tatari",
    honestyNotes: ["Managed-service heavy: expect human review cycles on creative and targeting."],
    typicalLeadTime: "Managed buys commonly need 5–10 business days before first air.",
  },
  {
    vendor: "tvscientific",
    label: "tvScientific",
    honestyNotes: ["Performance-TV platform with managed onboarding for new advertisers."],
    typicalLeadTime: "Allow a full week for onboarding + first flight.",
  },
];

export function vendorNote(vendor: string): ConciergeVendorNote | undefined {
  return CONCIERGE_VENDOR_NOTES.find((v) => v.vendor === vendor);
}

export interface ConciergeIoInput {
  workspaceId: string;
  campaignId: string;
  vendor: ConciergeVendor;
  advertiserName: string;
  audience: string;
  geo: string[];
  budgetCents: number;
  currency?: string;
  flightStart: string; // ISO
  flightEnd: string;
  validation: CreativeValidation;
  approvalObjectId: string;
  spotCount: number;
}

export interface GeneratedIo {
  ioDocument: Record<string, unknown>;
  creativeBrief: Record<string, unknown>;
}

/**
 * Generate the IO document + creative brief. The brief binds the validated
 * creative (sha/pin via creativeHashes at approval time); the IO carries
 * budget, flight, audience, geo, and the honesty notes for this vendor.
 */
export function generateIo(input: ConciergeIoInput): GeneratedIo {
  if (!input.validation.pass) {
    throw new Error("Cannot generate an IO for non-compliant creative — validate first.");
  }
  const vendor = vendorNote(input.vendor);
  const ioDocument = {
    kind: "ctv_insertion_order",
    version: 1,
    generatedAt: new Date().toISOString(),
    advertiserName: input.advertiserName,
    vendor: input.vendor,
    vendorLabel: vendor?.label ?? input.vendor,
    audience: input.audience,
    geo: input.geo,
    budgetCents: input.budgetCents,
    currency: input.currency ?? "USD",
    flightStart: input.flightStart,
    flightEnd: input.flightEnd,
    spotCount: input.spotCount,
    approvalObjectId: input.approvalObjectId,
    honestyNotes: vendor?.honestyNotes ?? [],
    typicalLeadTime: vendor?.typicalLeadTime ?? "Confirm with the vendor.",
    alertOnlyNotice: CONCIERGE_ALERT_ONLY_COPY,
  };
  const creativeBrief = {
    kind: "ctv_creative_brief",
    version: 1,
    spotLengths: input.validation.durationSeconds,
    spec: "IAB Tech Lab Dec 2025 draft — 1920×1080, MP4 H.264, stereo −23 LUFS / 48 kHz",
    validationChecks: input.validation.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
    publisherRulesVersion: input.validation.publisherRulesVersion,
  };
  return { ioDocument, creativeBrief };
}

const IO_TRANSITIONS: Record<CtvIoState, CtvIoState[]> = {
  draft: ["pending_vendor_approval", "cancelled"],
  pending_vendor_approval: ["human_placed", "cancelled"],
  human_placed: ["live", "cancelled"],
  live: ["reconciling", "cancelled"],
  reconciling: ["live", "cancelled"],
  cancelled: [],
};

/**
 * Transition an IO's state. Fail-closed: illegal transitions throw.
 * Audited by the caller (route) via store.audit.
 */
export async function transitionIo(
  store: CtvStore,
  workspaceId: string,
  ioId: string,
  to: CtvIoState,
  actor: string,
  opts: { placedBy?: string; vendorConfirmation?: string } = {},
): Promise<CtvIoRow> {
  const io = await store.getIo(workspaceId, ioId);
  if (!io) throw new Error("IO not found in workspace");
  const allowed = IO_TRANSITIONS[io.state] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Illegal IO transition ${io.state} → ${to} (allowed: ${allowed.join(", ") || "none"})`);
  }
  const patch: Partial<CtvIoRow> = { state: to };
  if (to === "human_placed") {
    patch.placedBy = opts.placedBy ?? actor;
    patch.placedAt = new Date();
    if (opts.vendorConfirmation) patch.vendorConfirmation = opts.vendorConfirmation;
  }
  const next = await store.updateIo(workspaceId, ioId, patch);
  if (!next) throw new Error("IO update failed");
  await store.audit({
    workspaceId, actor, action: "io_state_transition",
    subjectType: "io", subjectId: ioId,
    detail: { from: io.state, to },
  });
  return next;
}

export interface ConciergePauseAlert {
  alerted: true;
  campaignId: string;
  vendor: string;
  copy: string;
  /** What the human must do (vendor UI), since Marketr cannot act. */
  humanAction: string;
}

/**
 * Concierge pause = ALERT ONLY. There is no API behind these vendors, so
 * there is no pause to call — and this function must never pretend there
 * is. It returns the alert (callers surface it) and logs it; the campaign
 * state does NOT change.
 */
export async function requestConciergePause(
  store: CtvStore,
  workspaceId: string,
  campaignId: string,
  vendor: string,
  actor: string,
  reason: string,
): Promise<ConciergePauseAlert> {
  await store.audit({
    workspaceId, actor, action: "concierge_pause_alerted",
    subjectType: "campaign", subjectId: campaignId,
    detail: { vendor, reason, note: "alert-only; no pause executed" },
  });
  return {
    alerted: true,
    campaignId,
    vendor,
    copy: CONCIERGE_ALERT_ONLY_COPY,
    humanAction: `Open ${vendorNote(vendor)?.label ?? vendor} and pause the campaign yourself, then update the campaign status here. Reason: ${reason}`,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation: pixel + QR/pURL scans + platform report import.
// ---------------------------------------------------------------------------

export interface PlatformReportRow {
  date: string; // YYYY-MM-DD
  impressions: number;
  spendCents: number;
  clicks?: number;
  videoCompletions?: number;
}

/** Parse a vendor CSV export (date,impressions,spend) into report rows. */
export function parsePlatformReportCsv(csv: string): PlatformReportRow[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("Report CSV needs a header + at least one row");
  const header = lines[0]!.toLowerCase().split(",").map((h) => h.trim());
  const idx = (names: string[]) => {
    for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  const di = idx(["date", "day"]);
  const ii = idx(["impressions", "imps"]);
  const si = idx(["spend", "cost", "spend_usd"]);
  if (di < 0 || ii < 0 || si < 0) throw new Error("Report CSV needs date, impressions, and spend columns");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const spendRaw = Number(cells[si]);
    return {
      date: cells[di]!.trim(),
      impressions: Number(cells[ii]) || 0,
      spendCents: Math.round((Number.isFinite(spendRaw) ? spendRaw : 0) * 100),
    };
  });
}

export interface ReconciliationView {
  campaignId: string;
  pixelImpressions: number;
  qrScans: number;
  platformReport: { rows: number; impressions: number; spendCents: number } | null;
  /** Discrepancies are reported, never silently resolved. */
  discrepancies: string[];
  /** Invariant 11: no deterministic ROAS here — by type. */
  attributionNote: string;
}

export function reconcileConcierge(
  campaignId: string,
  pixelImpressions: number,
  qrScans: number,
  reportRows: PlatformReportRow[] | null,
): ReconciliationView {
  const discrepancies: string[] = [];
  let platformReport: ReconciliationView["platformReport"] = null;
  if (reportRows) {
    const impressions = reportRows.reduce((s, r) => s + r.impressions, 0);
    const spendCents = reportRows.reduce((s, r) => s + r.spendCents, 0);
    platformReport = { rows: reportRows.length, impressions, spendCents };
    if (pixelImpressions > 0 && impressions > 0) {
      const delta = Math.abs(pixelImpressions - impressions) / Math.max(impressions, 1);
      if (delta > 0.15) {
        discrepancies.push(
          `Pixel impressions (${pixelImpressions}) differ from platform report (${impressions}) by ${(delta * 100).toFixed(1)}% — investigate tag placement or viewability definition before trusting either number.`,
        );
      }
    }
  }
  return {
    campaignId,
    pixelImpressions,
    qrScans,
    platformReport,
    discrepancies,
    attributionNote:
      "Reconciliation joins three independent signals (ShapesOS pixel, QR/pURL scans, vendor report). " +
      "Impression-to-conversion remains probabilistic inference — deterministic CTV ROAS is never presented.",
  };
}
