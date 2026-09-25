// Marketr — R1 AI draft reply generator (fake LLM).
//
// SPEC-PHASE6.md §2/R1, §3/F2.
// Guardrails run pre-draft (./guardrails.ts) and are hard blocks: a flagged
// review never gets an AI draft. Sentiment routing: positives → standard
// queue; negatives → urgent flag for human eyes first.
//
// v1 is DRAFTS-ONLY: no auto-post code path exists anywhere in this track.

import type { ReviewSentiment } from "./types";

export interface DraftInput {
  reviewText: string;
  rating: number;
  sentiment: ReviewSentiment;
  reviewerName: string | null;
  businessName?: string | null;
}

// Fake-LLM template banks. Production would call a nano-class model;
// the bank keeps the same contract: (sentiment, reviewText) -> draft.
const POSITIVE_OPENERS = [
  "Thank you so much for the kind words!",
  "We really appreciate you taking the time to share this.",
  "This made our day — thank you!",
  "Thank you for the wonderful review.",
];
const NEGATIVE_OPENERS = [
  "Thank you for letting us know — we take this seriously.",
  "We're sorry to hear about your experience and appreciate you telling us.",
  "Thank you for the honest feedback. This isn't the experience we aim for.",
];
const NEUTRAL_OPENERS = [
  "Thank you for sharing your feedback.",
  "We appreciate you taking the time to leave a review.",
];

const POSITIVE_CLOSERS = [
  "We look forward to serving you again soon.",
  "Hope to see you again soon!",
  "Thanks again for choosing us.",
];
const NEGATIVE_CLOSERS = [
  "We'd welcome the chance to make this right — please reach out to us directly.",
  "If you're open to it, we'd like to learn more and make it right.",
];
const NEUTRAL_CLOSERS = [
  "We hope to earn that fifth star next time.",
  "Thanks for giving us a try — we hope to see you again.",
];

/** Deterministic pick so batteries get stable fixtures. */
function pick<T>(arr: T[], seed: string): T {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return arr[h % arr.length];
}

/** Strip anything the draft must never contain, even from templates. */
function sanitizeDraft(draft: string): string {
  return draft
    .replace(/!{2,}/g, "!") // exclamation runs are a known false-positive trigger
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function generateDraft(input: DraftInput): string {
  const seed = `${input.reviewText}||${input.rating}`;
  let opener: string;
  let closer: string;
  if (input.sentiment === "pos") {
    opener = pick(POSITIVE_OPENERS, seed);
    closer = pick(POSITIVE_CLOSERS, seed);
  } else if (input.sentiment === "neg") {
    opener = pick(NEGATIVE_OPENERS, seed);
    closer = pick(NEGATIVE_CLOSERS, seed);
  } else {
    opener = pick(NEUTRAL_OPENERS, seed);
    closer = pick(NEUTRAL_CLOSERS, seed);
  }

  const greeting = input.reviewerName ? `Hi ${input.reviewerName.split(" ")[0]}, ` : "";
  const business = input.businessName ? ` at ${input.businessName}` : "";
  // Never repeat the review's content verbatim, never name staff, never incentivize.
  const middle =
    input.sentiment === "neg"
      ? "Your experience matters to us, and we are looking into what happened."
      : input.sentiment === "pos"
        ? `We're glad you had a great experience${business}.`
        : `We're glad you stopped by${business}, and we value your feedback.`;

  return sanitizeDraft(`${greeting}${opener} ${middle} ${closer}`);
}

/**
 * Auto-sanitize + re-draft after a Google moderation REJECTED.
 * Strips likely triggers: exclamation runs, incentive-adjacent phrases,
 * and any echoed personal name, then generates a fresh conservative draft.
 */
export function sanitizeAndRedraft(args: {
  previousDraft: string;
  reviewText: string;
  rating: number;
  sentiment: ReviewSentiment;
  reviewerName: string | null;
  businessName?: string | null;
}): string {
  const stripped = args.previousDraft
    .replace(/!{2,}/g, ".") // collapse exclamation runs (false-positive trigger)
    .replace(/\b(free|discount|reward|gift card|coupon)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  void stripped; // informational: we re-draft from scratch rather than patching
  const conservative = generateDraft({
    reviewText: args.reviewText,
    rating: args.rating,
    sentiment: args.sentiment,
    reviewerName: null, // drop the name on re-draft — names are a known false positive
    businessName: args.businessName,
  });
  return conservative;
}
