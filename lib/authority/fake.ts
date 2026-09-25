// Marketr — Phase 6 provider adapters: fake-first, honest not-configured.
//
// House rule: fake/test mode is the default. Real adapters (Smartlead /
// Instantly, GBP, Local Data Exchange, LLM APIs) throw NotConfiguredError
// when their keys are absent — never silently pretend to work.

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

/** Resolve the partner: fake by default; real adapter throws honestly without a key. */
export function resolveSendingPartner(cfg: ProviderConfig & { provider?: "smartlead" | "instantly" }): SendingPartner {
  const providerName = cfg.provider ?? "smartlead";
  if (isFakeProvider(cfg)) return createFakeSendingPartner(providerName);
  requireConfigured("Smartlead/Instantly", cfg, "set SMARTLEAD_API_KEY or INSTANTLY_API_KEY in Settings → Authority.");
  // A real key is present but the live Smartlead/Instantly HTTP adapter is not
  // implemented yet — fail honestly rather than pretending to send.
  throw new NotConfiguredError(
    providerName,
    "live sending adapter not implemented in this build; fake mode remains the default. Tracked for a follow-up.",
  );
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
  if (isFakeProvider(cfg)) return createFakeLlmJudge();
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

export function resolveGbpClient(cfg: ProviderConfig): GbpClient {
  if (isFakeProvider(cfg)) return createFakeGbpClient();
  requireConfigured("Google Business Profile", cfg, "connect GBP in Settings → Authority → Listings (OAuth: business.manage).");
  throw new Error("unreachable");
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
  if (isFakeProvider(cfg)) return createFakeLdeClient();
  requireConfigured("Local Data Exchange", cfg, "set LDE_API_KEY in Settings → Authority → Listings.");
  throw new Error("unreachable");
}
