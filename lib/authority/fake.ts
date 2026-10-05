// Marketr — Phase 6 provider adapters: fake-first, honest not-configured.
//
// House rule: fake/test mode is the default. Real adapters (Smartlead /
// Instantly, GBP, Local Data Exchange, LLM APIs) throw NotConfiguredError
// when their keys are absent — never silently pretend to work.
//
// Phase 4b: the Smartlead / Instantly sending path is live
// (lib/authority/outreach/sending.ts, relay campaigns) and GBP is live
// through the workspace's Google Business Profile OAuth connection
// (lib/authority/reviews/gbpClient.ts → createLiveGbpClient below).

import { createInstantlyPartner, createSmartleadPartner, parseRelayCampaignIds } from "./outreach/sending";
import { gbpGetReview, gbpReplyToReview, gbpExecuteSync, planGbpSync } from "@/lib/connectors/m21/live/gbp";
import type { LiveDeps, TokenSource } from "@/lib/connectors/m21/live/http";
import { fakeProvidersAllowed } from "@/lib/env/secrets";

export class NotConfiguredError extends Error {
  readonly provider: string;
  constructor(provider: string, hint: string) {
    super(`${provider} is not configured: ${hint}`);
    this.name = "NotConfiguredError";
    this.provider = provider;
  }
}

export interface ProviderConfig {
  apiKey?: string | null;
  fake?: boolean;
}

/** True when no real key is present or fake mode is forced. */
export function isFakeProvider(cfg: ProviderConfig): boolean {
  return cfg.fake === true || !cfg.apiKey;
}

/** Throw the honest not-configured error for a real adapter path. */
export function requireConfigured(provider: string, cfg: ProviderConfig, hint: string): asserts cfg is ProviderConfig & { apiKey: string } {
  if (isFakeProvider(cfg)) throw new NotConfiguredError(provider, hint);
}

// ---------- Sending partners (Smartlead / Instantly) ----------

export interface SendRequest {
  to: string;
  subject: string;
  body: string;
  fromMailbox: string;
  campaignId: string;
  sequenceId: string;
  unsubscribeUrl: string;
  physicalAddress: string;
  /** Phase 4b: step index → relay campaign; also part of the idempotency key. */
  stepIndex?: number;
  /** Phase 4b: stable per (sequence, step) so a retried send never delivers twice. */
  idempotencyKey?: string;
  /** Phase 4b: echoed to the provider so webhooks can bind the tenant. */
  workspaceId?: string;
}

export interface SendResult {
  messageId: string;
  accepted: boolean;
  queuedAt: Date;
}

export interface SendingPartner {
  readonly name: "smartlead" | "instantly" | "fake";
  send(req: SendRequest): Promise<SendResult>;
  mailboxWarmupStatus(mailbox: string): Promise<{ daysWarmed: number; health: string }>;
}

/** Fake partner: records sends in memory, enforces nothing external. */
export function createFakeSendingPartner(name: "smartlead" | "instantly" = "smartlead"): SendingPartner & { sent: SendRequest[] } {
  const sent: SendRequest[] = [];
  return {
    name: "fake",
    sent,
    async send(req) {
      sent.push(req);
      return { messageId: `fake_${Date.now().toString(36)}`, accepted: true, queuedAt: new Date() };
    },
    async mailboxWarmupStatus() {
      return { daysWarmed: 35, health: "good" };
    },
  };
}

/**
 * Resolve the partner: fake by default; with a key the live relay-campaign
 * adapter (lib/authority/outreach/sending.ts). A key without relay campaign
 * ids throws NotConfiguredError — never a silent fake.
 */
export function resolveSendingPartner(
  cfg: ProviderConfig & {
    provider?: "smartlead" | "instantly";
    /** Comma-separated relay campaign ids, one per step (initial, follow-up 1, follow-up 2). */
    relayCampaignIds?: string | null;
    deps?: LiveDeps;
  },
): SendingPartner {
  const providerName = cfg.provider ?? "smartlead";
  const { relayCampaignIds: relayRaw, deps } = cfg;
  if (isFakeProvider(cfg) && fakeProvidersAllowed()) return createFakeSendingPartner(providerName);
  requireConfigured("Smartlead/Instantly", cfg, "set SMARTLEAD_API_KEY or INSTANTLY_API_KEY in Settings → Authority.");
  const relayCampaignIds = parseRelayCampaignIds(relayRaw);
  if (relayCampaignIds.length === 0) {
    const envName = providerName === "instantly" ? "INSTANTLY_RELAY_CAMPAIGN_IDS" : "SMARTLEAD_RELAY_CAMPAIGN_IDS";
    throw new NotConfiguredError(
      providerName,
      `set ${envName} to the relay campaign id(s) (one per sequence step) whose email step uses {{shapes_subject}} / {{shapes_body}}.`,
    );
  }
  return providerName === "instantly"
    ? createInstantlyPartner({ apiKey: cfg.apiKey, relayCampaignIds }, deps)
    : createSmartleadPartner({ apiKey: cfg.apiKey, relayCampaignIds }, deps);
}

// ---------- LLM judge (AEO) ----------

export interface JudgeInput {
  engine: string;
  prompt: string;
  responseText: string;
  brand: string;
}

export interface JudgeOutput {
  mentioned: boolean;
  position: number | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  competitors: string[];
  citedSources: string[];
  confidence: number;
}

export interface LlmJudge {
  readonly name: string;
  judge(input: JudgeInput): Promise<JudgeOutput>;
}

export function createFakeLlmJudge(): LlmJudge {
  return {
    name: "fake-nano-judge",
    async judge(input) {
      const text = input.responseText.toLowerCase();
      const brand = input.brand.toLowerCase();
      const mentioned = text.includes(brand);
      const urls = [...input.responseText.matchAll(/https?:\/\/([^\s)"']+)/g)].map((m) => m[1].split("/")[0]);
      return {
        mentioned,
        position: mentioned ? 1 : null,
        sentiment: mentioned ? "positive" : null,
        competitors: [],
        citedSources: [...new Set(urls)],
        confidence: 0.9,
      };
    },
  };
}

export function resolveLlmJudge(cfg: ProviderConfig): LlmJudge {
  if (isFakeProvider(cfg) && fakeProvidersAllowed()) return createFakeLlmJudge();
  requireConfigured("LLM judge", cfg, "set an LLM API key (OpenAI/Anthropic/Google) in Settings → Authority → AEO.");
  throw new Error("unreachable");
}

// ---------- GBP (listings + review replies) ----------

export interface GbpClient {
  readonly name: string;
  updateReply(locationRef: string, reviewId: string, replyText: string): Promise<{ reviewId: string }>;
  replyState(locationRef: string, reviewId: string): Promise<"PENDING" | "APPROVED" | "REJECTED">;
  syncProfile(locationRef: string, payload: Record<string, unknown>): Promise<{ ok: boolean }>;
}

export function createFakeGbpClient(): GbpClient & { moderationQueue: Map<string, "PENDING" | "APPROVED" | "REJECTED"> } {
  const moderationQueue = new Map<string, "PENDING" | "APPROVED" | "REJECTED">();
  return {
    name: "fake-gbp",
    moderationQueue,
    async updateReply(_loc, reviewId) {
      moderationQueue.set(reviewId, "PENDING"); // April 2026: every reply is pre-pub moderated
      return { reviewId };
    },
    async replyState(_loc, reviewId) {
      return moderationQueue.get(reviewId) ?? "APPROVED";
    },
    async syncProfile() {
      return { ok: true };
    },
  };
}

/**
 * Live GBP client over a vault OAuth token (Phase 4b). Reply posting, reply
 * moderation state, and profile sync (location fields, attributes, local
 * posts, photos) hit the Business Profile APIs; callers have already passed
 * the approval gates (review_reply_post / listing_edit receipts).
 */
export function createLiveGbpClient(auth: TokenSource, deps: LiveDeps = {}): GbpClient {
  return {
    name: "gbp",
    async updateReply(locationRef, reviewId, replyText) {
      await gbpReplyToReview(auth, locationRef, reviewId, replyText, deps);
      return { reviewId };
    },
    async replyState(locationRef, reviewId) {
      const review = await gbpGetReview(auth, locationRef, reviewId, deps);
      const state = review.reply?.state;
      if (state === "PENDING" || state === "APPROVED" || state === "REJECTED") return state;
      // A reply without a moderation state is published; no reply yet means
      // Google has not processed it.
      return review.reply ? "APPROVED" : "PENDING";
    },
    async syncProfile(locationRef, payload) {
      const { locationRef: _ignored, ...rest } = payload;
      void _ignored;
      await gbpExecuteSync(auth, locationRef, planGbpSync(locationRef, rest), deps);
      return { ok: true };
    },
  };
}

/**
 * Fake by default. The live client needs an OAuth token (the GBP API has no
 * API-key auth) — use gbpClientForWorkspace() in lib/authority/reviews/gbpClient.ts.
 */
export function resolveGbpClient(cfg: ProviderConfig & { auth?: TokenSource | null; deps?: LiveDeps }): GbpClient {
  if (cfg.auth) return createLiveGbpClient(cfg.auth, cfg.deps);
  if (isFakeProvider(cfg) && fakeProvidersAllowed()) return createFakeGbpClient();
  requireConfigured("Google Business Profile", cfg, "connect GBP in Settings → Authority → Listings (OAuth: business.manage).");
  throw new NotConfiguredError(
    "Google Business Profile",
    "the Business Profile API needs OAuth, not an API key — connect Google Business Profile in Settings → Connectors.",
  );
}

// ---------- Local Data Exchange (Tier 2, feature-flagged) ----------

export interface LdeClient {
  readonly name: string;
  probeSandbox(): Promise<{ ok: boolean; publishers: number; latencyMs: number }>;
}

export function createFakeLdeClient(): LdeClient {
  return {
    name: "fake-lde",
    async probeSandbox() {
      return { ok: true, publishers: 52, latencyMs: 180 };
    },
  };
}

export function resolveLdeClient(cfg: ProviderConfig & { featureFlag?: boolean }): LdeClient {
  if (cfg.featureFlag !== true) {
    throw new NotConfiguredError("Local Data Exchange", "the LDE prototype is behind a feature flag — enable it in Settings → Authority → Listings.");
  }
  if (isFakeProvider(cfg) && fakeProvidersAllowed()) return createFakeLdeClient();
  requireConfigured("Local Data Exchange", cfg, "set LDE_API_KEY in Settings → Authority → Listings.");
  throw new Error("unreachable");
}
