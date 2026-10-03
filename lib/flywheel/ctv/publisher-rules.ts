// Marketr — Phase 7 F4: publisher-specific creative rules.
//
// The IAB Tech Lab Dec 2025 draft is the base bar (see validator.ts); this
// table layers publisher-specific tightenings on top. Entries carry a
// `verifiedAt` date and a `provenance` note — publisher spec sheets move,
// so every entry tells the planner when it was last checked. Uncertain
// entries say so plainly instead of inventing specs.
//
// This table OVERRIDES ONLY BY TIGHTENING: a publisher rule can make a
// check stricter, never looser, than the IAB base.

/** Bump whenever any publisher row changes. */
export const PUBLISHER_RULES_VERSION = "ctv-publishers-2026-09-25";

export interface PublisherRule {
  key: string;
  name: string;
  /** How Marketr buys here: "api" (Vibe programmatic) or "concierge". */
  buyPath: "api" | "concierge";
  overrides: Record<string, unknown>;
  verifiedAt: string; // ISO date
  provenance: string;
}

export const PUBLISHER_RULES: PublisherRule[] = [
  {
    key: "tubi",
    name: "Tubi",
    buyPath: "concierge",
    overrides: {
      maxFileSizeGb: 5,
      notes: "Tubi's 2026 spec sheet requires 1080p mezzanine; loudness normalized house-side — submit at −23 LUFS anyway",
    },
    verifiedAt: "2026-09-25",
    provenance: "publicly documented publisher spec sheet; verify against current sheet before flight",
  },
  {
    key: "roku",
    name: "Roku Channel / Roku Ads Manager",
    buyPath: "concierge",
    overrides: {
      maxFileSizeGb: 10,
      notes: "Roku Ads Manager is the self-serve concierge path; Roku historically normalizes to −24 LUFS house-side — ShapesOS still validates at −23 LUFS and flags the delta",
    },
    verifiedAt: "2026-09-25",
    provenance: "publicly documented; loudness normalization behavior observed in market practice — confirm at IO time",
  },
  {
    key: "pluto",
    name: "Pluto TV",
    buyPath: "concierge",
    overrides: {
      notes: "Standard IAB base applies; Paramount's house sheet governs closed captions (supply captions when targeting accessibility-sensitive categories)",
    },
    verifiedAt: "2026-09-25",
    provenance: "publicly documented publisher guidance",
  },
  {
    key: "freevee",
    name: "Amazon Freevee",
    buyPath: "concierge",
    overrides: {
      notes: "Reachable via Amazon DSP (separate BYO-seat path); direct buys route through Amazon's ad specs — do not assume Freevee accepts Vibe-served VAST without confirmation",
    },
    verifiedAt: "2026-09-25",
    provenance: "Amazon advertising documentation; verify seat entitlements before creative lock",
  },
  {
    key: "hulu",
    name: "Hulu",
    buyPath: "concierge",
    overrides: {
      notes: "Disney's premium spec tier; creative approval review can add days — model pending_vendor_approval generously",
    },
    verifiedAt: "2026-09-25",
    provenance: "publicly documented publisher guidance",
  },
  {
    key: "peacock",
    name: "Peacock",
    buyPath: "concierge",
    overrides: {
      notes: "NBCU spec tier; see notes on approval lead time as for Hulu",
    },
    verifiedAt: "2026-09-25",
    provenance: "publicly documented publisher guidance",
  },
  {
    key: "samsung",
    name: "Samsung TV Plus",
    buyPath: "concierge",
    overrides: {
      notes: "FAST inventory; standard IAB base. Verify current house sheet at IO time — FAST specs change with platform updates",
    },
    verifiedAt: "2026-09-25",
    provenance: "market practice; verify before flight",
  },
  {
    key: "lg",
    name: "LG Channels",
    buyPath: "concierge",
    overrides: {
      notes: "FAST inventory; standard IAB base. Verify current house sheet at IO time",
    },
    verifiedAt: "2026-09-25",
    provenance: "market practice; verify before flight",
  },
  {
    key: "vibe-network",
    name: "Vibe.co streaming network",
    buyPath: "api",
    overrides: {
      notes: "Vibe's API accepts creative via /creatives/video (upload-url flow). Validate against IAB base before upload; Vibe re-validates server-side and rejects non-compliant files",
    },
    verifiedAt: "2026-09-25",
    provenance: "Vibe Developer Platform OpenAPI revision 2026-06-01 (verified 2026-09-25)",
  },
];

export function getPublisherRule(key: string): PublisherRule | undefined {
  return PUBLISHER_RULES.find((r) => r.key === key.toLowerCase());
}

/** Rules applied to a creative: IAB base version + publisher override keys. */
export function rulesForPublisher(key?: string): { version: string; overrides: Record<string, unknown> } {
  if (!key) return { version: PUBLISHER_RULES_VERSION, overrides: {} };
  const rule = getPublisherRule(key);
  if (!rule) return { version: PUBLISHER_RULES_VERSION, overrides: {} };
  return { version: `${PUBLISHER_RULES_VERSION}:${rule.key}`, overrides: rule.overrides };
}
