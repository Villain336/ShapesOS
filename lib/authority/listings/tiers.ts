// Marketr — Phase 6 L1 listings: honest tier taxonomy.
//
// Spec §9 invariant 10 / §2/L1: every channel carries its TRUE tier label
// in the UI — never imply automation where the tier is manual or
// guided_claim. This module is the single source of truth for that honesty.

export type ListingTier =
  | "api_synced"      // real API: Marketr edits the listing directly
  | "aggregator"      // programmatic breadth via an aggregator backend (LDE)
  | "manual"          // human performs the submission; Marketr tracks it
  | "guided_claim";   // Marketr walks the human through claiming; no automation

export const TIER_LABELS: Record<ListingTier, string> = {
  api_synced: "API-synced",
  aggregator: "Aggregator-distributed",
  manual: "Manual submission",
  guided_claim: "Guided claim",
};

export interface ChannelDefinition {
  channel: string;
  displayName: string;
  tier: ListingTier;
  /** The mandatory honest capability note — rendered verbatim on the card. */
  capabilityNote: string;
  /** Short list of what the tier can and cannot do. */
  canDo: string[];
  cannotDo: string[];
}

export const CHANNEL_DEFINITIONS: ChannelDefinition[] = [
  {
    channel: "gbp",
    displayName: "Google Business Profile",
    tier: "api_synced",
    capabilityNote:
      "API access requires application (ShapesOS's own 60+ day verified GBP + website); quota 0 QPM until approved. " +
      "Every profile edit is approval-bound and queued under the hard 10-edits/min/profile cap.",
    canDo: ["Edit NAP, hours, attributes, categories", "Upload photos", "Publish local posts (incl. recurring)"],
    cannotDo: ["Verification is owner-performed (postcard/video)", "No Q&A API (discontinued Nov 2025)"],
  },
  {
    channel: "bing",
    displayName: "Bing Places",
    tier: "api_synced",
    capabilityNote:
      "Trusted-partner application (sandbox first, then production). " +
      "Bing has no native reviews — reviews aggregate from TripAdvisor, Yelp, ThreeBestRated and Facebook; " +
      "ShapesOS redirects you to the source platforms for review replies.",
    canDo: ["Bulk NAP/hours/photo sync once approved", "Free GBP import (rebuilt Oct 2025)"],
    cannotDo: ["No native review system — reply on the source platform", "No trusted-partner API until application approved"],
  },
  {
    channel: "lde",
    displayName: "Local Data Exchange",
    tier: "aggregator",
    capabilityNote:
      "Prototype behind a feature flag — sandbox only until sync-accuracy validation passes. " +
      "~$0.008/call, 50+ publishers on day one. Promoted to default only after validation.",
    canDo: ["Programmatic citation breadth across 50+ publishers", "Sandbox probe before any production use"],
    cannotDo: ["Not the default distribution path until validation passes", "Per-call cost is passed through to the client"],
  },
  {
    channel: "apple",
    displayName: "Apple Business Connect",
    tier: "guided_claim",
    capabilityNote:
      "Guided claim only — no self-serve automation path exists (API is partner-only). " +
      "Review replies are NOT programmable on Apple — monitor only; Apple Maps reviews aggregate from partner " +
      "sources like Yelp, so respond there.",
    canDo: ["Step-by-step claim walkthrough", "NAP/hours/photo monitoring guidance"],
    cannotDo: ["No API access — never imply one-click management", "Review replies are monitor-only"],
  },
  {
    channel: "yelp",
    displayName: "Yelp",
    tier: "manual",
    capabilityNote:
      "Manual submission — ShapesOS prepares the pre-filled NAP payload and tracks completion; a human submits.",
    canDo: ["Pre-filled NAP payload", "Submission checklist + verification sweep"],
    cannotDo: ["No automated submission"],
  },
  {
    channel: "facebook",
    displayName: "Facebook / Meta",
    tier: "manual",
    capabilityNote:
      "Manual submission — ShapesOS prepares the pre-filled NAP payload and tracks completion; a human submits.",
    canDo: ["Pre-filled NAP payload", "Submission checklist + verification sweep"],
    cannotDo: ["No automated submission"],
  },
  {
    channel: "bbb",
    displayName: "Better Business Bureau",
    tier: "manual",
    capabilityNote:
      "Manual submission — ShapesOS prepares the pre-filled NAP payload and tracks completion; a human submits.",
    canDo: ["Pre-filled NAP payload", "Submission checklist + verification sweep"],
    cannotDo: ["No automated submission"],
  },
  {
    channel: "tripadvisor",
    displayName: "TripAdvisor",
    tier: "manual",
    capabilityNote:
      "Manual submission — a high-value niche directory for hospitality/travel. A human submits; ShapesOS tracks it.",
    canDo: ["Pre-filled NAP payload", "Submission checklist + verification sweep"],
    cannotDo: ["No automated submission"],
  },
  {
    channel: "healthgrades",
    displayName: "Healthgrades",
    tier: "manual",
    capabilityNote:
      "Manual submission — high-value niche directory for healthcare. A human submits; ShapesOS tracks it.",
    canDo: ["Pre-filled NAP payload", "Submission checklist + verification sweep"],
    cannotDo: ["No automated submission"],
  },
  {
    channel: "avvo",
    displayName: "Avvo",
    tier: "manual",
    capabilityNote:
      "Manual submission — high-value niche directory for legal. A human submits; ShapesOS tracks it.",
    canDo: ["Pre-filled NAP payload", "Submission checklist + verification sweep"],
    cannotDo: ["No automated submission"],
  },
  {
    channel: "houzz",
    displayName: "Houzz",
    tier: "manual",
    capabilityNote:
      "Manual submission — high-value niche directory for home services. A human submits; ShapesOS tracks it.",
    canDo: ["Pre-filled NAP payload", "Submission checklist + verification sweep"],
    cannotDo: ["No automated submission"],
  },
];

export interface ChannelTierInfo {
  channel: string;
  displayName: string;
  tier: ListingTier;
  tierLabel: string;
  capabilityNote: string;
  canDo: string[];
  cannotDo: string[];
}

/** The honest tier for a channel. Unknown channels default to `manual` — never to a more automated tier. */
export function channelTier(channel: string): ChannelTierInfo {
  const key = channel.trim().toLowerCase();
  const def = CHANNEL_DEFINITIONS.find((d) => d.channel === key);
  if (!def) {
    return {
      channel: key,
      displayName: key,
      tier: "manual",
      tierLabel: TIER_LABELS.manual,
      capabilityNote:
        "Manual submission — no API integration exists for this channel; ShapesOS tracks the submission, a human performs it.",
      canDo: ["Submission checklist + verification sweep"],
      cannotDo: ["No automated submission"],
    };
  }
  return {
    channel: def.channel,
    displayName: def.displayName,
    tier: def.tier,
    tierLabel: TIER_LABELS[def.tier],
    capabilityNote: def.capabilityNote,
    canDo: def.canDo,
    cannotDo: def.cannotDo,
  };
}
