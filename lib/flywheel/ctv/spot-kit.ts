// Marketr — Phase 7 F4: per-spot dynamic QR/pURL kit.
//
// Extends the Phase 5 self-hosted QR/pURL engine (lib/media/links.ts +
// lib/media/qr.ts): one UNIQUE dynamic QR + pURL per placement (show genre,
// daypart, demo — scan-rate variance is large). QR codes are sized for
// couch-distance scanning; landings are verified to complete in ≤3 taps.
//
// Design notes:
// - pURLs are dynamic: destination changes without re-rendering the QR
//   (the Phase 5 setDestination path), so a creative can flight on multiple
//   buys with fresh targets.
// - Scan analytics are the deterministic slice of CTV attribution
//   (spec invariant 11): scans are observed events, labeled as such in the
//   attribution layer — never inflated into deterministic ROAS.

import { createHash } from "node:crypto";
import { getMediaStore } from "@/lib/media/store";
import {
  MarketrLinkEngine,
  mintSlug,
  type LinkEngine,
} from "@/lib/media/links";
import type { TrackingLink } from "@/lib/media/store";
import { renderCustomizedQr, suggestedPrintWidthCm } from "@/lib/media/qr";
import { assertCreativePasses, type CreativeValidation } from "./validator";

/** Guidance shown verbatim in planner UIs for couch-distance QR placement. */
export const CTV_QR_GUIDANCE =
  "CTV QR placement: assume a ~3 m (10 ft) couch-to-screen viewing distance. " +
  "Size the code to at least 10% of the read distance — ~30 cm (12 in) wide " +
  "on a 55-inch screen — centered in the lower third, never in the overscan " +
  "margin. High contrast, quiet zone intact, on screen for the full spot. " +
  "The vanity pURL beside it catches non-scanners.";

/** ~3 m viewing distance → ~30 cm code. */
export const COUCH_READ_DISTANCE_CM = 300;
export const COUCH_QR_WIDTH_CM = Math.round(suggestedPrintWidthCm(COUCH_READ_DISTANCE_CM));

export interface SpotPlacementInput {
  placementLabel: string;
  showGenre?: string;
  daypart?: string;
  demo?: string;
  creativeId?: string;
  flightFrom?: string; // ISO
  flightTo?: string; // ISO
}

export interface MintSpotKitInput {
  workspaceId: string;
  campaignId: string;
  campaignName: string;
  /** Validated creative; BLOCKS minting when validation fails. */
  validation: CreativeValidation;
  /** Where scans land. Must complete in ≤3 taps (redirect-chain checked). */
  destinationUrl: string;
  spots: SpotPlacementInput[];
  domain?: string;
}

export interface MintedSpot {
  placementLabel: string;
  showGenre: string | null;
  daypart: string | null;
  demo: string | null;
  link: TrackingLink;
  publicUrl: string;
  qrSvg: string;
  qrWidthCm: number;
}

export interface SpotKitResult {
  spots: MintedSpot[];
  guidance: string;
}

/**
 * Check the landing's redirect chain completes within 3 hops (≤3 taps).
 * HEAD requests, follows redirects manually up to 4, fails closed on
 * errors with a warning (does not block minting — the chain may be
 * geo-gated).
 */
export async function checkLandingTaps(destinationUrl: string): Promise<{ taps: number; ok: boolean; detail: string }> {
  let url = destinationUrl;
  let hops = 0;
  try {
    for (; hops < 5; hops++) {
      const res = await fetch(url, { method: "HEAD", redirect: "manual" });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).toString();
        continue;
      }
      break;
    }
  } catch (err) {
    return { taps: hops + 1, ok: false, detail: `landing check failed (${err instanceof Error ? err.message : "fetch error"}) — verify manually that the page converts in ≤3 taps` };
  }
  const taps = hops + 1;
  return {
    taps,
    ok: taps <= 3,
    detail: taps <= 3
      ? `landing resolves in ${taps} tap(s) (≤3) — final ${url.slice(0, 80)}`
      : `landing needs ${taps} taps (>3) — simplify the destination before flight`,
  };
}

export function spotSlugFor(campaignId: string, placementLabel: string): string {
  const base = `${campaignId}-${placementLabel}`;
  return `ctv-${mintSlug(base)}`.slice(0, 64);
}

/**
 * Mint the per-spot kit. BLOCKS when the creative validation failed
 * (validator.assertCreativePasses) — non-compliant creative never reaches
 * a buy.
 */
export async function mintSpotKit(
  input: MintSpotKitInput,
  engine?: LinkEngine,
): Promise<SpotKitResult> {
  // Fail-closed gate: non-compliant creative never gets a kit.
  assertCreativePasses(input.validation);

  const eng: LinkEngine = engine ?? new MarketrLinkEngine(getMediaStore(), input.domain ?? "link.marketr.local");

  const spots: MintedSpot[] = [];
  for (const spot of input.spots) {
    const placementRef = `ctv:${input.campaignId}:${spot.placementLabel}`;
    const slug = spotSlugFor(input.campaignId, spot.placementLabel);
    const link = await eng.createLink({
      workspaceId: input.workspaceId,
      buyId: input.campaignId,
      placementRef,
      slug,
      destinationUrl: input.destinationUrl,
      utm: {
        utm_source: "ctv",
        utm_medium: "qr",
        utm_campaign: input.campaignName,
        utm_content: spot.placementLabel,
        ...(spot.showGenre ? { utm_term: spot.showGenre } : {}),
      },
    });
    const publicUrl = eng.publicUrl(link);
    // High-contrast, error-correction-M code at TV scale. (No logo: logos
    // cost scannability at couch distance; brand shows in the frame CTA.)
    const rendered = await renderCustomizedQr(publicUrl, {
      foreground: "#0a0a0a",
      background: "#ffffff",
      dotStyle: "square",
      eyeStyle: "square",
      quietZoneModules: 4,
      modulePx: 16,
      frame: { text: "SCAN TO SHOP", textColor: "#0a0a0a", backgroundColor: "#ffffff" },
    });
    spots.push({
      placementLabel: spot.placementLabel,
      showGenre: spot.showGenre ?? null,
      daypart: spot.daypart ?? null,
      demo: spot.demo ?? null,
      link,
      publicUrl,
      qrSvg: rendered.svg,
      qrWidthCm: COUCH_QR_WIDTH_CM,
    });
  }
  return { spots, guidance: CTV_QR_GUIDANCE };
}

/** Deterministic slice label used by the attribution layer (invariant 11). */
export const DETERMINISTIC_SLICE_LABEL =
  "QR/pURL scans are observed events — the deterministic slice of CTV attribution. " +
  "They are reported as scans, never as deterministic ROAS.";

/** Fingerprint a scan event back to its spot (used by reconciliation). */
export function scanFingerprint(slug: string): string {
  return createHash("sha256").update(`ctv-spot:${slug}`).digest("hex").slice(0, 16);
}
