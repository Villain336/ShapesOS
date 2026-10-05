// Marketr — R1 review intake: Pub/Sub webhook handling + sentiment classification.
//
// docs/specs/SPEC-PHASE6.md §2/R1, §3/F2.
// Pipeline: signature-verified webhook payload → idempotency check →
// sentiment classification (keyword heuristic + fake-LLM confirm) →
// guardrails (./guardrails.ts) → draft (./drafts.ts, v1 drafts-only).
//
// Pure + synchronous (memory twin for batteries). The prisma persistence
// lives in the API routes; this module owns the logic.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ReviewSentiment, ReviewSource, ReviewIntakePayload, IntakeResult } from "./types";
import { runGuardrails } from "./guardrails";
import { generateDraft } from "./drafts";
import { requireSecret } from "@/lib/env/secrets";

const POSITIVE_KEYWORDS = [
  "excellent", "amazing", "outstanding", "wonderful", "fantastic", "love", "loved",
  "great", "best", "awesome", "perfect", "highly recommend", "five star", "5 star",
  "thank", "appreciat", "impress", "delight", "prompt", "professional", "friendly",
  "helpful", "efficient", "quality", "recommend",
];
const NEGATIVE_KEYWORDS = [
  "terrible", "awful", "horrible", "worst", "hate", "disappoint", "rude", "poor",
  "bad experience", "never again", "avoid", "scam", "rip off", "unprofessional",
  "dirty", "late", "broken", "wrong", "complaint", "refund", "angry", "frustrat",
  "disgust", "one star", "1 star", "two star", "2 star",
];

/** Keyword-heuristic sentiment score in [-1, 1]. */
export function heuristicSentimentScore(text: string): number {
  const lower = text.toLowerCase();
  let pos = 0;
  let neg = 0;
  for (const kw of POSITIVE_KEYWORDS) if (lower.includes(kw)) pos += 1;
  for (const kw of NEGATIVE_KEYWORDS) if (lower.includes(kw)) neg += 1;
  const total = pos + neg;
  if (total === 0) return 0;
  return (pos - neg) / total;
}

/**
 * Fake-LLM sentiment confirm: in production this is a nano-class judge call.
 * Here it agrees with the heuristic unless the star rating disagrees strongly,
 * mirroring how the real judge would weight rating priors.
 */
export function fakeLlmSentimentConfirm(
  text: string,
  rating: number,
): { sentiment: ReviewSentiment; confidence: number } {
  const score = heuristicSentimentScore(text);
  let sentiment: ReviewSentiment;
  if (rating >= 4 && score >= -0.2) sentiment = "pos";
  else if (rating <= 2 && score <= 0.2) sentiment = "neg";
  else if (score > 0.15) sentiment = "pos";
  else if (score < -0.15) sentiment = "neg";
  else sentiment = "neu";
  const confidence = Math.min(0.98, 0.55 + Math.abs(score) * 0.45 + (rating >= 4 || rating <= 2 ? 0.1 : 0));
  return { sentiment, confidence };
}

export function classifySentiment(text: string, rating: number): { sentiment: ReviewSentiment; confidence: number } {
  if (!text.trim()) {
    // No text — the rating is the only signal.
    return rating >= 4
      ? { sentiment: "pos", confidence: 0.6 }
      : rating <= 2
        ? { sentiment: "neg", confidence: 0.6 }
        : { sentiment: "neu", confidence: 0.6 };
  }
  return fakeLlmSentimentConfirm(text, rating);
}

// ---------------------------------------------------------------------------
// Webhook signature verification (fake GBP Pub/Sub transport).
//
// Production GBP Pub/Sub uses OIDC JWTs; this fake transport uses a shared
// HMAC secret so routes can prove "signature-verified, idempotent" behavior.
// ---------------------------------------------------------------------------

export function webhookSecret(): string {
  return requireSecret("MARKETR_GBP_WEBHOOK_SECRET", "marketr-gbp-webhook-dev-secret");
}

/** HMAC-SHA256 signature of the raw body. The route compares this to the header. */
export function signWebhookBody(rawBody: string): string {
  return createHmac("sha256", webhookSecret()).update(rawBody, "utf8").digest("hex");
}

export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  try {
    const expected = Buffer.from(signWebhookBody(rawBody), "utf8");
    const actual = Buffer.from(signature.trim(), "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Idempotency: message-id ledger (memory twin; routes ALSO rely on the DB's
// unique (workspaceId, source, reviewId) constraint as the durable guard).
// ---------------------------------------------------------------------------

export function createIntakeIdempotencyLedger() {
  const seen = new Set<string>();
  return {
    seenKey(key: string): boolean {
      return seen.has(key);
    },
    markSeen(key: string): void {
      seen.add(key);
    },
    size(): number {
      return seen.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Full intake pipeline (pure): classify → guardrails → draft.
// The API route persists the result into review_queue.
// ---------------------------------------------------------------------------

export function intakeReview(payload: ReviewIntakePayload): IntakeResult {
  const { review } = payload;
  const rating = Math.min(5, Math.max(1, Math.round(review.rating)));
  const { sentiment } = classifySentiment(review.text, rating);
  const urgency = sentiment === "neg" ? "urgent" : "standard";

  const guardrail = runGuardrails({
    reviewText: review.text,
    reviewerName: review.reviewerName ?? null,
    rating,
  });

  if (guardrail.blocked) {
    return {
      reviewId: review.reviewId,
      locationRef: review.locationRef,
      source: review.source as ReviewSource,
      rating,
      sentiment,
      urgency,
      guardrailFlags: guardrail.flags,
      draftBlocked: true,
      draftReply: null,
      deduped: false,
    };
  }

  const draftReply = generateDraft({
    reviewText: review.text,
    rating,
    sentiment,
    reviewerName: review.reviewerName ?? null,
  });

  return {
    reviewId: review.reviewId,
    locationRef: review.locationRef,
    source: review.source as ReviewSource,
    rating,
    sentiment,
    urgency,
    guardrailFlags: guardrail.flags,
    draftBlocked: false,
    draftReply,
    deduped: false,
  };
}
