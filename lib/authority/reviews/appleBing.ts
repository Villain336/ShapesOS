// Marketr — R1 Apple / Bing behavior (monitor + sync, replies manual).
//
// docs/specs/SPEC-PHASE6.md §2/R1, §9 invariant 10 (listings honesty is a UI rule).
// Both channels are honestly labeled:
// - Apple Business Connect: listing sync + read/monitor. Review replies are
//   NOT programmable — respond on the partner source instead.
// - Bing Places: NAP/hours/photo sync. No native review system at all —
//   reviews aggregate from TripAdvisor/Yelp/ThreeBestRated/Facebook; the
//   agent redirects to the source platform.

export const APPLE_TIER_LABEL = "guided claim" as const;
export const BING_TIER_LABEL = "API-synced" as const;

export class NotProgrammableError extends Error {
  readonly channel: "apple" | "bing";
  constructor(channel: "apple" | "bing", message: string) {
    super(message);
    this.name = "NotProgrammableError";
    this.channel = channel;
  }
}

/** Apple: review replies are NOT programmable via API. This is a hard error, not a stub. */
export function applePostReviewReply(args: {
  reviewRef: string;
  replyText: string;
}): never {
  throw new NotProgrammableError(
    "apple",
    `Apple Business Connect exposes no review-reply API — reply for review ${args.reviewRef} cannot be posted programmatically. ` +
      `Apple Maps reviews aggregate from partner sources (e.g., Yelp); respond on the source platform. Channel label: ${APPLE_TIER_LABEL} (listing sync + monitor only).`,
  );
}

/** Apple listing sync is read/monitor + NAP update through the guided-claim flow. */
export function appleListingSyncStatus(): {
  tier: typeof APPLE_TIER_LABEL;
  capabilities: string[];
  limitations: string[];
} {
  return {
    tier: APPLE_TIER_LABEL,
    capabilities: ["NAP sync", "hours sync", "read/monitor reviews"],
    limitations: [
      "No self-serve API (partner-only; Apple folded Business Connect into the wider Apple Business platform, 2026-04)",
      "Review replies are NOT programmable — respond on partner sources",
      "Verification is owner-performed through the guided claim flow",
    ],
  };
}

/** Bing: no native review system. Reviews aggregate from source platforms. */
export function bingReviewRedirect(args: { reviewRef: string }): {
  reviewRef: string;
  message: string;
  sourcePlatforms: string[];
} {
  return {
    reviewRef: args.reviewRef,
    message:
      "Bing Places has no native review system. Bing reviews aggregate from third-party sources — respond on the source platform, not in Bing.",
    sourcePlatforms: ["TripAdvisor", "Yelp", "ThreeBestRated", "Facebook"],
  };
}

/** Bing NAP/hours/photo sync payload validation. */
export function validateBingSync(payload: Record<string, unknown>): void {
  const nap = payload.nap as Record<string, unknown> | undefined;
  if (nap) {
    for (const field of ["name", "address", "phone"] as const) {
      if (typeof nap[field] !== "string" || !(nap[field] as string).trim()) {
        throw new Error(`Bing sync requires NAP.${field}.`);
      }
    }
  }
}

/** Honest capability matrix for the UI tier labels. */
export function channelCapabilities(): Record<
  string,
  { tier: string; reviewReplies: string; sync: string[] }
> {
  return {
    gbp: {
      tier: "API-synced",
      reviewReplies: "programmable (approval-bound, pre-publication moderated)",
      sync: ["hours", "attributes", "categories", "photos", "local posts", "recurring posts"],
    },
    apple: {
      tier: APPLE_TIER_LABEL,
      reviewReplies: "NOT programmable — respond on partner sources (honest error)",
      sync: ["NAP", "hours", "read/monitor reviews"],
    },
    bing: {
      tier: BING_TIER_LABEL,
      reviewReplies: "no native reviews — redirects to source platforms",
      sync: ["NAP", "hours", "photos"],
    },
  };
}
