// Marketr — Phase 7 F4: CTV attribution layer.
//
// LAYERED AND PROBABILISTIC (spec invariant 11): impression-to-conversion
// on CTV is device-graph inference or geo-holdout experiment — never
// ledger-grade. The layers:
//   1. Impression pixel (Marketr-hosted 1×1; impressions log locally)
//   2. View-through windows (probabilistic credit, labeled as inferred)
//   3. QR/pURL scans — the DETERMINISTIC slice, labeled as such
//   4. Branded-search-lift report template (post-flight, directional)
//   5. Geo-holdout planner (incrementality)
//
// Deterministic CTV ROAS is NEVER presented — by type. There is no field,
// function, or template in this module that renders one. The verify battery
// asserts this structurally.

import { createHmac } from "node:crypto";
import { requireSecret } from "@/lib/env/secrets";

/** Layers, in the order the UI presents them. */
export const ATTRIBUTION_LAYERS = [
  "impression_pixel",
  "view_through",
  "qr_scan_deterministic",
  "branded_search_lift",
  "geo_holdout",
] as const;
export type AttributionLayer = (typeof ATTRIBUTION_LAYERS)[number];

export const PROBABILISTIC_DISCLAIMER =
  "CTV attribution is layered and probabilistic. Impression-to-conversion is device-graph " +
  "inference or geo-holdout experiment — never ledger-grade. QR/pURL scans are the deterministic " +
  "slice and are labeled as such. Deterministic CTV ROAS is never presented.";

export const DETERMINISTIC_SLICE_NOTE =
  "QR/pURL scans are observed events: a scan happened at a known time from a known spot. " +
  "They are the deterministic slice of CTV attribution and are reported as scans — not as ROAS.";

// ---------------------------------------------------------------------------
// Impression pixel
// ---------------------------------------------------------------------------

const PIXEL_GIF_BASE64 = "R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

export function pixelGifBuffer(): Buffer {
  return Buffer.from(PIXEL_GIF_BASE64, "base64");
}

/** Pixel signing secret. Production must set PIXEL_SIGNING_SECRET (fails closed). */
export function pixelSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  return requireSecret("PIXEL_SIGNING_SECRET", "dev-only-pixel-secret", env);
}

/** Campaign-scoped token: verifiable against the pixel's campaign id. */
export function signPixelToken(campaignId: string, secret: string): string {
  return createHmac("sha256", secret).update(`ctv-pixel:${campaignId}`).digest("hex").slice(0, 32);
}

/** Verify the token presented on a pixel hit. */
export function verifyPixelToken(campaignId: string, token: string, secret: string): boolean {
  const expected = signPixelToken(campaignId, secret);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/** The pixel URL the buyer pastes into Vibe/vendor as the impression tracker. */
export function pixelUrl(baseUrl: string, pixelId: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/flywheel/ctv/pixel/${pixelId}?t=${token}`;
}

// ---------------------------------------------------------------------------
// View-through windows
// ---------------------------------------------------------------------------

export type ViewThroughWindow = 1 | 7 | 14 | 30;

export interface ViewThroughAttribution {
  layer: "view_through";
  windowDays: ViewThroughWindow;
  impressions: number;
  attributedConversions: number;
  /** Modeled, not observed — always labeled. */
  inference: "device_graph_modeled";
  confidence: "directional";
  disclaimer: string;
}

/**
 * View-through credit: impressions seen, conversions in the window after the
 * impression, credited with a decayed weight. This is INFERENCE — the
 * function names say so, and the UI must render the disclaimer.
 */
export function viewThroughCredit(
  impressions: number,
  conversionsInWindow: number,
  windowDays: ViewThroughWindow,
): ViewThroughAttribution {
  // Decay: a conversion 14 days after an impression carries less credit.
  const decay = Math.exp(-windowDays / 21);
  return {
    layer: "view_through",
    windowDays,
    impressions,
    attributedConversions: Math.round(conversionsInWindow * decay * 100) / 100,
    inference: "device_graph_modeled",
    confidence: "directional",
    disclaimer:
      `View-through credit is modeled, not observed (window ${windowDays}d, decay-weighted). ` +
      "Treat as directional; confirm with a geo holdout for incrementality.",
  };
}

// ---------------------------------------------------------------------------
// Branded-search-lift report template
// ---------------------------------------------------------------------------

export interface SearchLiftInput {
  /** Daily branded-search impressions/clicks, pre-flight baseline. */
  baselineDaily: number[];
  /** Daily branded-search during/post flight. */
  flightDaily: number[];
}

export interface SearchLiftReport {
  layer: "branded_search_lift";
  baselineMean: number;
  flightMean: number;
  liftPct: number | null;
  /** Simple two-sample signal check; NOT a significance claim. */
  signal: "up" | "flat" | "down" | "insufficient_data";
  method: string;
  disclaimer: string;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function brandedSearchLift(input: SearchLiftInput): SearchLiftReport {
  const baselineMean = mean(input.baselineDaily);
  const flightMean = mean(input.flightDaily);
  const enough = input.baselineDaily.length >= 7 && input.flightDaily.length >= 7 && baselineMean > 0;
  const liftPct = baselineMean > 0 ? ((flightMean - baselineMean) / baselineMean) * 100 : null;
  const signal = !enough
    ? "insufficient_data"
    : liftPct !== null && liftPct > 10 ? "up" : liftPct !== null && liftPct < -10 ? "down" : "flat";
  return {
    layer: "branded_search_lift",
    baselineMean: Math.round(baselineMean * 10) / 10,
    flightMean: Math.round(flightMean * 10) / 10,
    liftPct: liftPct === null ? null : Math.round(liftPct * 10) / 10,
    signal,
    method: "Pre/post comparison of branded-search volume (≥7 days each side). No causal claim — seasonality and other media confound.",
    disclaimer:
      "Search lift is directional evidence, not proof of causation. " +
      "It complements — never replaces — holdout-based incrementality.",
  };
}

// ---------------------------------------------------------------------------
// Geo-holdout planner
// ---------------------------------------------------------------------------

export interface GeoHoldoutPlan {
  layer: "geo_holdout";
  testDmas: string[];
  controlDmas: string[];
  minFlightDays: number;
  /** Minimum detectable lift given the planned impressions (honest math). */
  minDetectableLiftPct: number | null;
  method: string;
  disclaimer: string;
}

/**
 * Honest planner: with the planned impression volume, what lift is even
 * detectable? Refuses to plan below the floor — it says so instead of
 * manufacturing precision.
 */
export function planGeoHoldout(opts: {
  testDmas: string[];
  controlDmas: string[];
  plannedImpressions: number;
  expectedConversionRate: number; // e.g. 0.002
  minFlightDays?: number;
}): GeoHoldoutPlan {
  const expectedConversions = opts.plannedImpressions * opts.expectedConversionRate;
  // Rule of thumb: need ~380 conversions per cell for 80% power at 20% MDE.
  const minDetectableLiftPct =
    expectedConversions >= 100
      ? Math.round((2.8 / Math.sqrt(expectedConversions)) * 100 * 10) / 10
      : null;
  return {
    layer: "geo_holdout",
    testDmas: opts.testDmas,
    controlDmas: opts.controlDmas,
    minFlightDays: opts.minFlightDays ?? 21,
    minDetectableLiftPct,
    method:
      "Test vs control DMAs, ≥21-day flight, pre-period matched on baseline sales. " +
      "Incrementality = (test lift − control lift) / baseline.",
    disclaimer:
      minDetectableLiftPct === null
        ? "Planned volume is too small for a powered holdout (<100 expected conversions/cell) — run the QR/pURL + search-lift layers only, or raise the flight."
        : `With this volume you can detect ≥${minDetectableLiftPct}% lift at 80% power. Smaller effects are unmeasurable — say so, don't smooth it.`,
  };
}

// ---------------------------------------------------------------------------
// The combined attribution view
// ---------------------------------------------------------------------------

export interface CtvAttributionView {
  campaignId: string;
  layers: {
    impressionPixel: { impressions: number; pixelUrl: string; viewThroughWindowDays: number };
    viewThrough: ViewThroughAttribution;
    qrScans: { scans: number; deterministicSliceNote: string };
    searchLift: SearchLiftReport | null;
    geoHoldout: GeoHoldoutPlan | null;
  };
  probabilisticDisclaimer: string;
  // NOTE: there is intentionally no `roas` field. Deterministic CTV ROAS is
  // never presented (invariant 11). Add spend efficiency as directional
  // modeled ranges only if a future spec explicitly allows it.
}

export interface AttributionViewInput {
  campaignId: string;
  pixelUrl: string;
  pixelImpressions: number;
  viewThroughWindowDays: number;
  conversionsInViewThroughWindow: number;
  qrScans: number;
  searchLift: SearchLiftInput | null;
  geoHoldout: Parameters<typeof planGeoHoldout>[0] | null;
}

export function buildAttributionView(input: AttributionViewInput): CtvAttributionView {
  const windowDays = ([1, 7, 14, 30] as const).includes(input.viewThroughWindowDays as 1 | 7 | 14 | 30)
    ? (input.viewThroughWindowDays as ViewThroughWindow)
    : 14;
  return {
    campaignId: input.campaignId,
    layers: {
      impressionPixel: {
        impressions: input.pixelImpressions,
        pixelUrl: input.pixelUrl,
        viewThroughWindowDays: windowDays,
      },
      viewThrough: viewThroughCredit(input.pixelImpressions, input.conversionsInViewThroughWindow, windowDays),
      qrScans: { scans: input.qrScans, deterministicSliceNote: DETERMINISTIC_SLICE_NOTE },
      searchLift: input.searchLift ? brandedSearchLift(input.searchLift) : null,
      geoHoldout: input.geoHoldout ? planGeoHoldout(input.geoHoldout) : null,
    },
    probabilisticDisclaimer: PROBABILISTIC_DISCLAIMER,
  };
}

/**
 * Structural guard: throws if anything in the rendered view claims a
 * deterministic ROAS. The battery calls this on every attribution render.
 */
export function assertNoDeterministicRoas(view: unknown): void {
  const text = JSON.stringify(view).toLowerCase();
  const banned = ["deterministic_roas", "deterministic roas", "\"roas\"", "roas:"];
  for (const b of banned) {
    if (text.includes(b)) {
      throw new Error(`Invariant 11 violated: attribution view contains a deterministic ROAS claim (${b})`);
    }
  }
  // The view MUST carry the probabilistic disclaimer.
  if (!text.includes("probabilistic")) {
    throw new Error("Invariant 11 violated: attribution view is missing the probabilistic disclaimer");
  }
}
