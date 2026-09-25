// Marketr — Phase 4 T1 (Mail Engine): provider abstraction.
//
// Mirrors lib/messaging/provider.ts: one interface, a fake provider for
// dev/tests (default), real providers (Lob, PostGrid) behind
// workspace-configured encrypted keys, and honest "not configured" errors
// when credentials are missing.
//
// Channel:
// - Direct mail: Lob (real) | PostGrid (real) | FakeMailProvider (default).
//
// Money posture (standing rule): test keys default; a live send is
// IMPOSSIBLE through lib/mail/service.ts without an approved MailApproval
// (status approved) + the provider row in mode "live" + spend within
// maxSpendCents. The providers themselves never consult approvals —
// service.ts is the gate.
//
// Verification costs (docs/phase4-research.md, 2026-09-24):
// - PostGrid: address verification is FREE/included in the addr API key.
// - Lob: verification is a PAID add-on (~$0.05/lookup on Developer tier).
//   estimateCost surfaces the fee as a line item; service.ts never calls
//   verifyAddress silently in a send path — verifyAddresses() is an explicit
//   campaign step and its cost is part of the approved estimate.
//
// Webhook signatures:
// - Lob: HMAC-SHA256(secret, "<Lob-Signature-Timestamp>.<rawBody>"), hex
//   digest, compared to the Lob-Signature header (per Lob's webhook guide,
//   cross-checked against community integrations citing help.lob.com — NOT
//   yet verified against a live firing; flagged in the battery report).
// - PostGrid: the delivery is a JWT signed (HS256) with the webhook secret.
//   The token is read from `Authorization: Bearer <jwt>` or the body field
//   `token`/`jwt` — the exact PostGrid delivery field is UNVERIFIED, so both
//   are accepted and the mechanism is flagged for live confirmation.

import { createHash, timingSafeEqual } from "node:crypto";

export type MailProviderName = "fake" | "lob" | "postgrid";

/** Provider mode: "test" = test key (render-only), "live" = real postage. */
export type MailProviderMode = "test" | "live";

/** US street address. Snapshotted onto each MailPiece at build time. */
export interface MailAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

export type MailFormat = "postcard_4x6" | "postcard_6x9" | "postcard_6x11" | "letter";

/** CASS-style verification outcome. "quarantined" = never mailed. */
export type MailVerificationStatus = "valid" | "corrected" | "quarantined";

export interface VerificationResult {
  status: MailVerificationStatus;
  /** Provider-normalized address (present when status is corrected). */
  correctedAddress?: MailAddress;
  /** e.g. "dpv_confirmed", "ncoa_changed", "undeliverable". */
  deliverability?: string | null;
  /** Human-readable notes (no key material). */
  notes?: string;
}

export interface EstimateSpec {
  format: MailFormat;
  /** Number of sendable (non-quarantined, non-suppressed) pieces. */
  count: number;
  /** Number of verification lookups the campaign will run. */
  verifications: number;
}

export interface CostLineItem {
  label: string;
  /** Integer cents. */
  cents: number;
  /** Quantity the line applies to (1 for fees). */
  quantity: number;
  /** "documented_estimate" (no live pricing endpoint) | "provider_actual". */
  basis: "documented_estimate" | "provider_actual";
  note?: string;
}

export interface SendPieceInput {
  address: MailAddress;
  /** Merge variables for the creative template. */
  mergeVariables?: Record<string, string>;
  /** Unique per-piece tracking slug (minted by service.ts). */
  qrSlug: string;
  /** Lob/PostGrid idempotency key: deterministic per piece. */
  idempotencyKey: string;
}

export interface SendPieceResult {
  providerPieceId: string;
  /** True when nothing was physically mailed (fake or test-key render). */
  renderedOnly: boolean;
}

/** Normalized delivery events (Lob scan events, PostGrid JWT events). */
export type MailEventType =
  | "in_transit"
  | "in_local_area"
  | "processed_for_delivery"
  | "delivered"
  | "returned"
  | "failed";

export interface MailEvent {
  /** Provider's event id — the MailWebhookEvent idempotency key. */
  eventId: string;
  type: MailEventType;
  providerPieceId: string;
  occurredAt: Date;
  raw: unknown;
}

export interface ValidateConnectionResult {
  ok: boolean;
  /** Provider-reported identity/detail (key id, account — no secrets). */
  detail?: string;
}

export interface MailProvider {
  readonly name: MailProviderName;
  /** Light API call proving the key works (test endpoint for test keys). */
  validateConnection(): Promise<ValidateConnectionResult>;
  /** CASS-ish verification. Lob charges per call — callers must budget it. */
  verifyAddress(addr: MailAddress): Promise<VerificationResult>;
  /** Pre-send cost estimate as line items. Never a live charge. */
  estimateCost(spec: EstimateSpec): Promise<CostLineItem[]>;
  /** Send one piece. Test keys / fake render without mailing. */
  sendPiece(piece: SendPieceInput, opts: { testMode: boolean }): Promise<SendPieceResult>;
  /** Cancel a scheduled (not yet printed) piece. */
  cancelPiece(providerPieceId: string): Promise<void>;
  /** Authenticate an inbound webhook. Constant-time compare. */
  validateWebhookSignature(opts: {
    rawBody: string;
    signature: string | null;
    timestamp?: string | null;
  }): boolean;
  /** Normalize a verified provider payload into MailEvents. */
  parseWebhook(payload: unknown): Promise<MailEvent[]>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string, missing: string) {
    super(`${provider} provider is not configured (missing ${missing})`);
    this.name = "ProviderNotConfiguredError";
  }
}

// ---------------------------------------------------------------------------
// Documented per-piece cost table.
//
// Source: docs/phase4-research.md (2026-09-24), which grounds the Lob
// Developer-tier numbers in Sep-2026 sources (Oppizi, SaaSworthy, G2,
// Vendr). PostGrid's published per-piece pricing was NOT captured in that
// research, so PostGrid estimates fall back to the Lob-documented numbers
// with the note field saying so — refresh from the PostGrid dashboard
// before quoting live. No provider exposes a live pricing endpoint, so
// these are documented estimates; F7 reconciles against invoice actuals.
// ---------------------------------------------------------------------------

export interface DocumentedPieceCost {
  postcard4x6Cents: number;
  postcard6x9Cents: number;
  postcard6x11Cents: number;
  letterCents: number;
  /** Verification add-on per lookup (Lob; PostGrid verification is free). */
  verificationCents: number;
  sourceNote: string;
}

export const DOCUMENTED_COSTS: Record<"lob" | "postgrid", DocumentedPieceCost> = {
  lob: {
    postcard4x6Cents: 85, // Developer tier ~$0.80–$0.91 → midpoint-ish $0.85
    postcard6x9Cents: 99,
    postcard6x11Cents: 135,
    letterCents: 94, // Developer $0.94/letter
    verificationCents: 5, // ~$0.05/additional US verification (Developer)
    sourceNote:
      "Lob Developer-tier estimates from docs/phase4-research.md (Sep-2026 sources: Oppizi, SaaSworthy, G2, Vendr).",
  },
  postgrid: {
    postcard4x6Cents: 85,
    postcard6x9Cents: 99,
    postcard6x11Cents: 135,
    letterCents: 94,
    verificationCents: 0, // PostGrid verification is free/included
    sourceNote:
      "PostGrid per-piece pricing not captured in research — falls back to Lob-documented estimates. Refresh from the PostGrid dashboard before quoting live. Verification: free/included.",
  },
};

export function pieceCentsFor(provider: "lob" | "postgrid", format: MailFormat): number {
  const t = DOCUMENTED_COSTS[provider];
  switch (format) {
    case "postcard_4x6":
      return t.postcard4x6Cents;
    case "postcard_6x9":
      return t.postcard6x9Cents;
    case "postcard_6x11":
      return t.postcard6x11Cents;
    case "letter":
      return t.letterCents;
  }
}

/** sha256 hex — used for creative-hash binding and deterministic ids. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Constant-time string compare that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Redact a key to a UI-safe hint (e.g. "••••a1b2"). */
export function keyHint(key: string): string {
  const tail = key.trim().slice(-4);
  return tail ? `••••${tail}` : "••••";
}
