// ShapesOS — Phase 15.4 (zernio): a FAKE Zernio server (MOCK). NOT ZERNIO.
//
// An in-memory, fetch-compatible stand-in for the Zernio REST API, built from
// its OpenAPI spec (v1.217.1) — request validation, response bodies, status
// codes and error envelopes follow the operations named in the comments.
// It exists so ShapesOS can be tested end to end without a Zernio key, and so
// dev/demo installs (no ZERNIO_API_KEY, fakes allowed) show a working,
// clearly labelled flow. Every response carries `x-zernio-fake: MOCK`, every
// name it invents ends in "(MOCK)", and lib/zernio/config.ts refuses it in
// production (withNoFakesGuard rules). Nothing here proves the live API —
// see the UNVERIFIED-LIVE list in the Phase 15.4 report.
//
// What it models (all multi-tenant by profile, like the real team account):
//   profiles (createProfile idempotency + profile_name_conflict 409),
//   accounts per profile (connect flows collapse Zernio's hosted consent into
//   an immediate redirect), ads accounts and their platform ad accounts,
//   campaigns with budgets and status, the validateOnly dry run (501 outside
//   Meta / Google PMax+Demand Gen / OpenAI), Meta's 30 creates per ad account
//   per rolling 5 minutes (validateOnly counted) with Retry-After, posts with
//   Idempotency-Key replay, presigned media upload, and usage metering.
// Tests read `calls` to assert what was (and was not) sent.

import { createHash } from "node:crypto";
import {
  ZERNIO_ADS_CONNECT_PLATFORMS,
  ZERNIO_SOCIAL_PLATFORMS,
  accountCategory,
  campaignPlatformForAccount,
  validateOnlySupported,
  type ZernioAccountDoc,
  type ZernioAdAccountDoc,
  type ZernioBudget,
  type ZernioCampaignDoc,
  type ZernioPostDoc,
  type ZernioProfileDoc,
  type ZernioInboxConversation,
  type ZernioInboxMessage,
} from "./spec";

export const FAKE_ZERNIO_LABEL = "FAKE Zernio (MOCK) — in-memory stand-in built from the Zernio OpenAPI spec v1.217.1";

export interface FakeCall {
  operationId: string;
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  idempotencyKey: string | null;
}

interface FakeAccount extends ZernioAccountDoc {
  profileId: string;
}

interface FakeCampaign extends ZernioCampaignDoc {
  accountId: string;
  profileId: string;
  platformAdAccountId: string;
  budget: ZernioBudget | null;
  budgetLevel: "campaign" | "adset";
  currency: string;
  status: string;
  platformCampaignStatus: string;
}

export interface FakeZernioOptions {
  /** The bearer token the fake accepts (default: any non-empty token). */
  apiKey?: string;
  /** Meta creates per ad account per rolling 5 minutes, validateOnly included (spec: 30). */
  metaCreatesPerWindow?: number;
  /** Clock (ms) — tests advance it. */
  now?: () => number;
}

type Handler = (req: FakeRequest) => FakeResponse | Promise<FakeResponse>;
interface FakeRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  idempotencyKey: string | null;
  setOperation: (id: string) => void;
}
interface FakeResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const MOCK = " (MOCK)";
const WINDOW_MS = 5 * 60 * 1000;

function err(status: number, error: string, extra: Record<string, unknown> = {}): FakeResponse {
  return { status, body: { error, ...extra } };
}

function hash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");
}

export class FakeZernio {
  readonly label = FAKE_ZERNIO_LABEL;
  readonly calls: FakeCall[] = [];
  readonly profiles = new Map<string, ZernioProfileDoc>();
  readonly accounts = new Map<string, FakeAccount>();
  readonly adAccounts = new Map<string, ZernioAdAccountDoc[]>();
  readonly campaigns = new Map<string, FakeCampaign>();
  readonly posts = new Map<string, ZernioPostDoc & { profileIds: string[] }>();
  /** Phase 18.2 (WS=comms): inbox conversations (social DMs) by conversation id. */
  readonly conversations = new Map<string, { conv: ZernioInboxConversation; messages: ZernioInboxMessage[] }>();
  readonly leadForms: Array<Record<string, unknown>> = [];
  readonly audiences: Array<Record<string, unknown>> = [];
  /** Managed-ads fees (USD) per profile for GET /v1/usage metering mode. */
  readonly managedAdsUsd = new Map<string, number>();
  /** createStandaloneAd validateOnly failures to return (Meta's verbatim 400). */
  validateFailure: ((body: Record<string, unknown>) => Record<string, unknown> | null) | null = null;
  private readonly idem = new Map<string, { bodyHash: string; res: FakeResponse }>();
  private readonly metaWindow = new Map<string, number[]>();
  private readonly queuedErrors: Array<{ operationId: string; res: FakeResponse }> = [];
  private seq = 0;
  private remaining = 600;
  private readonly opts: Required<Pick<FakeZernioOptions, "metaCreatesPerWindow">> & FakeZernioOptions;
  private readonly routes: Array<{ method: string; re: RegExp; keys: string[]; op: string; handler: Handler }> = [];

  constructor(opts: FakeZernioOptions = {}) {
    this.opts = { metaCreatesPerWindow: 30, ...opts };
    this.register();
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** A deterministic 24-hex id (Zernio ids are Mongo ObjectIds). */
  private id(prefix: string): string {
    this.seq += 1;
    const h = createHash("sha256").update(`${prefix}:${this.seq}`).digest("hex");
    return h.slice(0, 24);
  }

  /** Make the next call of `operationId` fail with this response (tests). */
  failNext(operationId: string, res: { status: number; body?: unknown; retryAfterSec?: number }): void {
    this.queuedErrors.push({
      operationId,
      res: {
        status: res.status,
        body: res.body ?? { error: `Injected ${res.status}`, code: res.status === 429 ? "rate_limited" : "injected" },
        headers: res.retryAfterSec !== undefined ? { "retry-after": String(res.retryAfterSec) } : undefined,
      },
    });
  }

  /** Calls of one operation (tests). */
  callsOf(operationId: string): FakeCall[] {
    return this.calls.filter((c) => c.operationId === operationId);
  }

  // ── Seeding helpers (the fake's stand-in for Zernio's hosted consent screens) ──

  /** Ensure a profile with this id exists (dev mock mode after a restart). */
  adoptProfile(profileId: string, name: string): void {
    if (!this.profiles.has(profileId)) {
      this.profiles.set(profileId, { _id: profileId, name, isDefault: false, createdAt: new Date(this.now()).toISOString() });
    }
  }

  /** Connect an account on a profile (what the hosted consent flow ends in). */
  connectAccount(profileId: string, platform: string, opts: { username?: string; accountId?: string } = {}): FakeAccount {
    const id = opts.accountId ?? this.id(`acct:${profileId}:${platform}`);
    const username = opts.username ?? `${platform}_demo${MOCK}`;
    const acct: FakeAccount = {
      _id: id,
      platform,
      profileId,
      username,
      displayName: `${platform} account${MOCK}`,
      isActive: true,
      enabled: true,
      needsReconnection: false,
    };
    this.accounts.set(id, acct);
    if (accountCategory(platform) === "ads") {
      const n = 100000000 + this.seq;
      const adId = platform === "metaads" ? `act_${n}` : String(n);
      this.adAccounts.set(id, [
        { id: adId, name: `${platform} ad account${MOCK}`, currency: "USD", accountStatus: 1, selectable: true, unusableReason: null, billingStatus: "ok" },
      ]);
    }
    return acct;
  }

  /** Phase 18.2: seed a DM conversation on an account (tests; the list also seeds one per DM account). */
  seedConversation(accountId: string, input: { participantName?: string; messages?: { text: string; direction?: "incoming" | "outgoing"; at?: string }[] } = {}): ZernioInboxConversation {
    const acct = this.accounts.get(accountId);
    if (!acct) throw new Error(`FakeZernio: no account ${accountId}`);
    const id = `conv_${this.id(`conv:${accountId}:${this.conversations.size}`)}`;
    const name = input.participantName ?? `Customer${MOCK}`;
    const msgs = (input.messages ?? [{ text: `Hi! Is this still available?${MOCK}`, direction: "incoming" as const }]).map((m, i) => ({
      id: `m_${this.id(`msg:${id}:${i}`)}`,
      conversationId: id,
      accountId,
      platform: acct.platform,
      message: m.text,
      senderId: m.direction === "outgoing" ? accountId : `p_${id}`,
      senderName: m.direction === "outgoing" ? (acct.username ?? null) : name,
      direction: m.direction ?? "incoming",
      createdAt: m.at ?? new Date(this.now() - (60 - i) * 60_000).toISOString(),
    }));
    const last = msgs[msgs.length - 1];
    const conv: ZernioInboxConversation = {
      id,
      platform: acct.platform,
      accountId,
      accountUsername: acct.username,
      participantId: `p_${id}`,
      participantName: name,
      lastMessage: last?.message ?? "",
      updatedTime: last?.createdAt ?? new Date(this.now()).toISOString(),
      status: "active",
      unreadCount: msgs.filter((m) => m.direction === "incoming").length,
      url: null,
    };
    this.conversations.set(id, { conv, messages: msgs });
    return conv;
  }

  /** Seed a campaign on an ads account (synced campaigns the real API would discover). */
  seedCampaign(input: {
    accountId: string;
    adAccountId?: string;
    name?: string;
    budget?: ZernioBudget | null;
    budgetLevel?: "campaign" | "adset";
    status?: "active" | "paused";
    spendPerDay?: number;
  }): FakeCampaign {
    const acct = this.accounts.get(input.accountId);
    if (!acct) throw new Error(`fake: no account ${input.accountId}`);
    const platform = campaignPlatformForAccount(acct.platform) ?? "facebook";
    const adAccountId = input.adAccountId ?? this.adAccounts.get(acct._id)?.[0]?.id ?? "act_1";
    const id = String(200000000 + this.seq++ * 7);
    const status = input.status ?? "active";
    const spend = input.spendPerDay ?? 12.5;
    const c: FakeCampaign = {
      platformCampaignId: id,
      platform,
      campaignName: `${input.name ?? "Campaign"}${MOCK}`,
      status,
      platformCampaignStatus: status === "active" ? "ACTIVE" : "PAUSED",
      budget: input.budget === undefined ? { amount: 20, type: "daily" } : input.budget,
      budgetLevel: input.budgetLevel ?? "campaign",
      currency: "USD",
      metrics: { spend: spend * 3, impressions: 3000, clicks: 90, ctr: 3, conversions: 4.5, purchaseValue: 120 },
      platformAdAccountId: adAccountId,
      platformAdAccountName: `${acct.platform} ad account${MOCK}`,
      accountId: acct._id,
      profileId: acct.profileId,
      adCount: 1,
    };
    this.campaigns.set(id, c);
    return c;
  }

  // ── HTTP surface ───────────────────────────────────────────────────────

  /** fetch-compatible entry point (pass as fetchImpl). */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const res = await this.handle(url, method, headers, init?.body);
    const out = new Headers({
      "content-type": "application/json",
      "x-zernio-fake": "MOCK",
      "x-ratelimit-limit": "600",
      "x-ratelimit-remaining": String(Math.max(0, (this.remaining -= 1))),
      "x-ratelimit-reset": String(Math.floor(this.now() / 1000) + 60),
      ...(res.headers ?? {}),
    });
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), { status: res.status, headers: out });
  };

  private async handle(url: URL, method: string, headers: Headers, rawBody: unknown): Promise<FakeResponse> {
    // Presigned media upload target (cloud storage, not the API).
    if (url.pathname.startsWith("/fake-upload/")) {
      this.calls.push({ operationId: "uploadMedia", method, path: url.pathname, query: {}, body: null, idempotencyKey: null });
      return method === "PUT" ? { status: 200, body: {} } : err(405, "Method not allowed");
    }
    const path = url.pathname.replace(/^\/api/, "");
    let body: Record<string, unknown> | null = null;
    if (typeof rawBody === "string" && rawBody) {
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return err(400, "Invalid JSON body", { type: "invalid_request_error", code: "invalid_json" });
      }
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const idempotencyKey = headers.get("idempotency-key");
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1] ?? "")]));
      let operationId = r.op;
      const call: FakeCall = { operationId, method, path, query, body, idempotencyKey };
      this.calls.push(call);
      // Unauthorized (components.responses.Unauthorized).
      const auth = headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token) return err(401, "Missing API key. Send it as Authorization: Bearer <your API key>.", { type: "authentication_error", code: "missing_credentials" });
      if (this.opts.apiKey && token !== this.opts.apiKey) return err(401, "Invalid API key.", { type: "authentication_error", code: "invalid_credentials" });
      const queued = this.queuedErrors.findIndex((q) => q.operationId === r.op);
      if (queued >= 0) return this.queuedErrors.splice(queued, 1)[0]!.res;
      return r.handler({
        method, path, params, query, body, idempotencyKey,
        setOperation: (id) => {
          operationId = id;
          call.operationId = id;
        },
      });
    }
    this.calls.push({ operationId: "unknown", method, path, query, body, idempotencyKey });
    return err(404, "Not found");
  }

  private route(method: string, pattern: string, op: string, handler: Handler): void {
    const keys: string[] = [];
    const re = new RegExp(`^${pattern.replace(/\{(\w+)\}/g, (_, k: string) => {
      keys.push(k);
      return "([^/]+)";
    })}$`);
    this.routes.push({ method, re, keys, op, handler });
  }

  /** Idempotency-Key replay: same key + same body → the stored response; different body → 422. */
  private idempotent(req: FakeRequest, run: () => FakeResponse): FakeResponse {
    if (!req.idempotencyKey) return run();
    const bodyHash = hash(req.body);
    const prior = this.idem.get(`${req.path}|${req.idempotencyKey}`);
    if (prior) {
      if (prior.bodyHash !== bodyHash) return err(422, "Idempotency-Key reused with a different request", { code: "idempotency_key_reused" });
      return { ...prior.res, headers: { ...(prior.res.headers ?? {}), "idempotent-replayed": "true" } };
    }
    const res = run();
    if (res.status >= 200 && res.status < 300) this.idem.set(`${req.path}|${req.idempotencyKey}`, { bodyHash, res });
    return res;
  }

  private profileAccounts(profileId: string): FakeAccount[] {
    return [...this.accounts.values()].filter((a) => a.profileId === profileId);
  }

  private publicAccount(a: FakeAccount): ZernioAccountDoc {
    const p = this.profiles.get(a.profileId);
    return { ...a, profileId: { _id: a.profileId, name: p?.name ?? "", slug: (p?.name ?? "").toLowerCase().replace(/\W+/g, "-") } };
  }

  private register(): void {
    // listProfiles — GET /v1/profiles
    this.route("GET", "/v1/profiles", "listProfiles", (req) => {
      const all = [...this.profiles.values()];
      return { status: 200, body: { profiles: req.query.name ? all.filter((p) => p.name === req.query.name) : all } };
    });
    // createProfile — POST /v1/profiles
    this.route("POST", "/v1/profiles", "createProfile", (req) =>
      this.idempotent(req, () => {
        const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
        if (!name) return err(400, "name is required", { type: "invalid_request_error", code: "missing_required_field", param: "name" });
        const existing = [...this.profiles.values()].find((p) => p.name === name);
        if (existing) {
          return err(409, "A profile with this name already exists", {
            type: "invalid_request_error", code: "profile_name_conflict", details: { existingProfileId: existing._id },
          });
        }
        const profile: ZernioProfileDoc = {
          _id: this.id(`profile:${name}`),
          name,
          description: typeof req.body?.description === "string" ? req.body.description : undefined,
          isDefault: false,
          createdAt: new Date(this.now()).toISOString(),
        };
        this.profiles.set(profile._id, profile);
        return { status: 201, body: { message: "Profile created successfully", profile } };
      }),
    );
    // getProfile — GET /v1/profiles/{profileId}
    this.route("GET", "/v1/profiles/{profileId}", "getProfile", (req) => {
      const p = this.profiles.get(req.params.profileId!);
      return p ? { status: 200, body: { profile: p } } : err(404, "Not found");
    });
    // getAllAccountsHealth — GET /v1/accounts/health (registered before /v1/accounts/{id})
    this.route("GET", "/v1/accounts/health", "getAllAccountsHealth", (req) => {
      const list = req.query.profileId ? this.profileAccounts(req.query.profileId) : [...this.accounts.values()];
      const accounts = list.map((a) => ({
        accountId: a._id,
        platform: a.platform,
        username: a.username,
        displayName: a.displayName,
        profileId: a.profileId,
        status: a.needsReconnection ? "error" : "healthy",
        canPost: !a.needsReconnection && accountCategory(a.platform) !== "ads",
        canFetchAnalytics: !a.needsReconnection,
        tokenValid: !a.needsReconnection,
        needsReconnect: !!a.needsReconnection,
        issues: a.needsReconnection ? ["Token expired"] : [],
      }));
      const healthy = accounts.filter((a) => a.status === "healthy").length;
      return {
        status: 200,
        body: {
          summary: { total: accounts.length, healthy, warning: 0, error: accounts.length - healthy, needsReconnect: accounts.length - healthy },
          accounts,
        },
      };
    });
    // listAccounts — GET /v1/accounts
    this.route("GET", "/v1/accounts", "listAccounts", (req) => {
      if (req.query.profileId && !/^[a-f0-9]{24}$/i.test(req.query.profileId)) {
        return err(400, "profileId must be a valid ObjectId", { type: "invalid_request_error", code: "invalid_field_value", param: "profileId" });
      }
      let list = req.query.profileId ? this.profileAccounts(req.query.profileId) : [...this.accounts.values()];
      if (req.query.platform) list = list.filter((a) => a.platform === req.query.platform);
      if (req.query.category) list = list.filter((a) => accountCategory(a.platform) === req.query.category);
      return { status: 200, body: { accounts: list.map((a) => this.publicAccount(a)), hasAnalyticsAccess: false } };
    });
    // getConnectUrl — GET /v1/connect/{platform}
    this.route("GET", "/v1/connect/{platform}", "getConnectUrl", (req) => {
      const platform = req.params.platform!;
      if (!(ZERNIO_SOCIAL_PLATFORMS as readonly string[]).includes(platform)) {
        return err(400, `Unsupported platform: ${platform}`, { type: "invalid_request_error", code: "unsupported_platform" });
      }
      const profileId = req.query.profileId ?? "";
      if (!this.profiles.has(profileId)) return err(404, "Profile not found", { type: "not_found", code: "profile_not_found" });
      if (platform === "snapchat") return err(403, "Snapchat is a closed beta.", { type: "permission_error", code: "PLATFORM_BETA_RESTRICTED" });
      const redirect = req.query.redirect_url ?? "";
      if (redirect && !/^https?:\/\//.test(redirect)) return err(400, "redirect_url must be absolute", { code: "INVALID_REDIRECT_URL" });
      if (platform === "twitter" && encodeURIComponent(redirect).length > 258) {
        return err(400, "redirect_url is too long for X's OAuth state", { code: "INVALID_REDIRECT_URL", param: "redirect_url" });
      }
      // The hosted selection UI, collapsed: the account connects now and the
      // browser lands on redirect_url with the standard success params.
      const acct = this.connectAccount(profileId, platform);
      const target = new URL(redirect || "https://zernio.com/dashboard");
      target.searchParams.set("connected", platform);
      target.searchParams.set("profileId", profileId);
      target.searchParams.set("accountId", acct._id);
      target.searchParams.set("username", acct.username ?? "");
      return { status: 200, body: { authUrl: target.toString(), state: `fake-${acct._id}` } };
    });
    // connectAds — GET /v1/connect/{platform}/ads
    this.route("GET", "/v1/connect/{platform}/ads", "connectAds", (req) => {
      const platform = req.params.platform!;
      if (!(ZERNIO_ADS_CONNECT_PLATFORMS as readonly string[]).includes(platform)) {
        return err(400, "Platform doesn't support ads", { code: "unsupported_platform" });
      }
      const profileId = req.query.profileId ?? "";
      if (!this.profiles.has(profileId)) return err(404, "Profile not found", { code: "profile_not_found" });
      const adsPlatform =
        platform === "facebook" || platform === "instagram" ? "metaads" : platform === "googleads" ? "googleads" : platform === "twitter" ? "xads" : `${platform}ads`;
      if (platform === "twitter") {
        const posting = this.accounts.get(req.query.accountId ?? "");
        if (!posting || posting.platform !== "twitter" || posting.profileId !== profileId) {
          return err(400, "accountId of an X posting account on this profile is required for X Ads", { code: "missing_required_field", param: "accountId" });
        }
      }
      const existing = this.profileAccounts(profileId).find((a) => a.platform === adsPlatform);
      if (existing) {
        return { status: 200, body: { alreadyConnected: true, accountId: existing._id, platform, username: existing.username, displayName: existing.displayName } };
      }
      const acct = this.connectAccount(profileId, adsPlatform);
      const target = new URL(req.query.redirect_url || "https://zernio.com/dashboard");
      target.searchParams.set("connected", adsPlatform);
      target.searchParams.set("profileId", profileId);
      target.searchParams.set("accountId", acct._id);
      return { status: 200, body: { authUrl: target.toString(), state: `fake-${acct._id}` } };
    });
    // connectOpenAIAdsCredentials — POST /v1/connect/openai-ads/credentials
    this.route("POST", "/v1/connect/openai-ads/credentials", "connectOpenAIAdsCredentials", (req) => {
      const profileId = String(req.body?.profileId ?? "");
      if (!this.profiles.has(profileId)) return err(404, "Profile not found", { code: "profile_not_found" });
      const key = String(req.body?.apiKey ?? "");
      if (!key.startsWith("sk-")) return err(401, "The API key could not read an OpenAI ad account", { code: "invalid_credentials" });
      const acct = this.connectAccount(profileId, "openaiads");
      return { status: 200, body: { accountId: acct._id, adAccountName: `OpenAI ad account${MOCK}` } };
    });
    // getAdAccountLiveEntities — GET /v1/ads/accounts/live (Meta only)
    this.route("GET", "/v1/ads/accounts/live", "getAdAccountLiveEntities", (req) => {
      const acct = this.accounts.get(req.query.accountId ?? "");
      if (!acct) return err(404, "Account ID not found.", { type: "not_found", code: "account_not_found", param: "accountId" });
      if (acct.platform !== "metaads") return err(501, "The platform has no bulk live read (only Meta today).", { code: "feature_not_available" });
      const campaigns = [...this.campaigns.values()]
        .filter((c) => c.accountId === acct._id && c.platformAdAccountId === req.query.adAccountId)
        .map((c) => ({
          platformCampaignId: c.platformCampaignId,
          campaignName: c.campaignName,
          platformCampaignStatus: c.platformCampaignStatus,
          configuredStatus: c.platformCampaignStatus,
          status: c.status,
          budget: c.budgetLevel === "campaign" ? c.budget : null,
          dailyBudget: c.budgetLevel === "campaign" && c.budget?.type === "daily" ? c.budget.amount : null,
          lifetimeBudget: c.budgetLevel === "campaign" && c.budget?.type === "lifetime" ? c.budget.amount : null,
        }));
      return {
        status: 200,
        body: {
          accountId: acct._id, adAccountId: req.query.adAccountId, platform: "facebook", currency: "USD",
          readAt: new Date(this.now()).toISOString(), campaigns, paging: { campaigns: { after: null } },
        },
      };
    });
    // listAdAccounts — GET /v1/ads/accounts
    this.route("GET", "/v1/ads/accounts", "listAdAccounts", (req) => {
      const acct = this.accounts.get(req.query.accountId ?? "");
      if (!acct) return err(404, "Account ID not found.", { type: "not_found", code: "account_not_found", param: "accountId" });
      return { status: 200, body: { accounts: this.adAccounts.get(acct._id) ?? [] } };
    });
    // listAdCampaigns — GET /v1/ads/campaigns
    this.route("GET", "/v1/ads/campaigns", "listAdCampaigns", (req) => {
      const list = this.filterCampaigns(req.query);
      return { status: 200, body: { campaigns: list, pagination: { page: 1, limit: 20, total: list.length, pages: 1 } } };
    });
    // getAdTree — GET /v1/ads/tree
    this.route("GET", "/v1/ads/tree", "getAdTree", (req) => {
      const list = this.filterCampaigns(req.query).map((c) => ({
        ...c,
        adSets: [],
        ...(req.query.timeIncrement === "1" ? { daily: this.daily(c, req.query.fromDate, req.query.toDate) } : {}),
      }));
      return { status: 200, body: { campaigns: list, pagination: { page: 1, limit: 20, total: list.length, pages: 1 } } };
    });
    // getCampaignAnalytics — GET /v1/ads/campaigns/{campaignId}/analytics
    this.route("GET", "/v1/ads/campaigns/{campaignId}/analytics", "getCampaignAnalytics", (req) => {
      const c = this.campaigns.get(req.params.campaignId!);
      if (!c || (req.query.platform && req.query.platform !== c.platform)) return err(404, "Not found");
      return {
        status: 200,
        body: {
          campaign: { id: c.platformCampaignId, name: c.campaignName, platform: c.platform, status: c.platformCampaignStatus, currency: c.currency },
          analytics: { summary: c.metrics, daily: this.daily(c, req.query.fromDate, req.query.toDate) },
        },
      };
    });
    // updateAdCampaignStatus — PUT /v1/ads/campaigns/{campaignId}/status
    this.route("PUT", "/v1/ads/campaigns/{campaignId}/status", "updateAdCampaignStatus", (req) => {
      const c = this.campaigns.get(req.params.campaignId!);
      const status = req.body?.status;
      if (status !== "active" && status !== "paused") return err(400, "status must be active or paused", { code: "invalid_field_value", param: "status" });
      if (!c || req.body?.platform !== c.platform) return err(404, "No ads found for this campaign");
      const already = c.status === status;
      c.status = status;
      c.platformCampaignStatus = status === "active" ? "ACTIVE" : "PAUSED";
      return {
        status: 200,
        body: {
          status, platformCampaignStatus: c.platformCampaignStatus, statusReadAt: new Date(this.now()).toISOString(),
          updated: already ? 0 : 1, skipped: already ? 1 : 0,
          skippedReasons: already ? [`Campaign already switched ${status === "active" ? "on" : "off"}`] : [],
        },
      };
    });
    // updateAdCampaign — PUT /v1/ads/campaigns/{campaignId}
    this.route("PUT", "/v1/ads/campaigns/{campaignId}", "updateAdCampaign", (req) => {
      const c = this.campaigns.get(req.params.campaignId!);
      const platform = String(req.body?.platform ?? "");
      if (!["facebook", "instagram", "google"].includes(platform)) return err(400, "platform must be facebook, instagram or google", { param: "platform" });
      if (!c) return err(404, "Account ID not found.", { code: "account_not_found" });
      const budget = req.body?.budget as ZernioBudget | undefined;
      if (!budget || typeof budget.amount !== "number" || !["daily", "lifetime"].includes(budget.type)) {
        return err(400, "Send at least one of budget, bidStrategy, portfolioBidStrategyId, name or platformSpecificData", { code: "missing_required_field" });
      }
      if (c.budgetLevel === "adset") return err(409, "Meta campaign is ABO: update the ad set budget instead", { code: "abo_campaign" });
      c.budget = { amount: budget.amount, type: budget.type };
      return { status: 200, body: { updated: 1, budget: c.budget, budgetLevel: "campaign" } };
    });
    // createStandaloneAd — POST /v1/ads/create
    this.route("POST", "/v1/ads/create", "createStandaloneAd", (req) => this.createAd(req));
    // listLeadForms / createLeadForm — /v1/ads/lead-forms
    this.route("GET", "/v1/ads/lead-forms", "listLeadForms", (req) => {
      if (!this.accounts.has(req.query.accountId ?? "")) return err(404, "Account ID not found.", { code: "account_not_found" });
      return { status: 200, body: { status: "success", forms: this.leadForms.filter((f) => f.accountId === req.query.accountId), pagination: { hasMore: false, cursor: null } } };
    });
    this.route("POST", "/v1/ads/lead-forms", "createLeadForm", (req) => {
      const accountId = String(req.body?.accountId ?? "");
      if (!this.accounts.has(accountId)) return err(404, "Account ID not found.", { code: "account_not_found" });
      if (!req.body?.name || !req.body?.privacyPolicyUrl) return err(400, "name and privacyPolicyUrl are required", { code: "missing_required_field" });
      const form = { id: this.id("form"), accountId, name: `${String(req.body.name)}`, status: "ACTIVE" };
      this.leadForms.push(form);
      return { status: 201, body: { status: "success", form } };
    });
    // listAdAudiences / createAdAudience — /v1/ads/audiences
    this.route("GET", "/v1/ads/audiences", "listAdAudiences", (req) => {
      if (!this.accounts.has(req.query.accountId ?? "")) return err(404, "Account ID not found.", { code: "account_not_found" });
      return { status: 200, body: { audiences: this.audiences.filter((a) => a.accountId === req.query.accountId && a.adAccountId === req.query.adAccountId) } };
    });
    this.route("POST", "/v1/ads/audiences", "createAdAudience", (req) => {
      const accountId = String(req.body?.accountId ?? "");
      if (!this.accounts.has(accountId)) return err(404, "Account ID not found.", { code: "account_not_found" });
      if (!req.body?.name || !req.body?.type) return err(400, "name and type are required", { code: "missing_required_field" });
      const audience = { id: this.id("aud"), accountId, adAccountId: req.body.adAccountId ?? null, name: String(req.body.name), type: String(req.body.type), status: "pending", size: 0 };
      this.audiences.push(audience);
      return { status: 201, body: { audience } };
    });
    // createPost — POST /v1/posts
    this.route("POST", "/v1/posts", "createPost", (req) => this.createPost(req));
    // getPost — GET /v1/posts/{postId}
    this.route("GET", "/v1/posts/{postId}", "getPost", (req) => {
      const p = this.posts.get(req.params.postId!);
      return p ? { status: 200, body: { post: p } } : err(404, "Not found");
    });
    // getPostTimeline — GET /v1/analytics/post-timeline
    this.route("GET", "/v1/analytics/post-timeline", "getPostTimeline", (req) => {
      const p = this.posts.get(req.query.postId ?? "");
      if (!p) return err(404, "Not found");
      if (!p.publishedAt) return { status: 200, body: { postId: p._id, timeline: [] } };
      const day = p.publishedAt.slice(0, 10);
      const timeline = (p.platforms ?? []).map((t) => ({ date: day, platform: t.platform, impressions: 420, reach: 300, likes: 21, comments: 3, shares: 2, saves: 1, clicks: 9, views: 0 }));
      return { status: 200, body: { postId: p._id, timeline } };
    });
    // getMediaPresignedUrl — POST /v1/media/presign
    this.route("POST", "/v1/media/presign", "getMediaPresignedUrl", (req) => {
      const filename = String(req.body?.filename ?? "");
      if (!filename || !req.body?.contentType) return err(400, "Invalid request (missing filename, unsupported contentType, or size out of range)");
      const key = `temp/${this.id("media")}_${filename.replace(/[^\w.-]/g, "_")}`;
      return { status: 200, body: { uploadUrl: `https://media.zernio.com/fake-upload/${key}`, publicUrl: `https://media.zernio.com/${key}`, key, expiresIn: 3600 } };
    });
    // getUsage — GET /v1/usage (metering mode with profileId projection)
    // Phase 18.2 (WS=comms): the inbox (Messages group). DM platforms per the
    // list endpoint's description; one "(MOCK)" conversation is seeded per DM
    // account the first time a profile's inbox is listed.
    const DM_PLATFORMS = new Set(["facebook", "instagram", "twitter", "bluesky", "reddit", "telegram", "whatsapp"]);
    // listInboxConversations — GET /v1/inbox/conversations
    this.route("GET", "/v1/inbox/conversations", "listInboxConversations", (req) => {
      const accounts = (req.query.profileId ? this.profileAccounts(req.query.profileId) : [...this.accounts.values()]).filter((a) => DM_PLATFORMS.has(a.platform));
      for (const a of accounts) {
        if (![...this.conversations.values()].some((c) => c.conv.accountId === a._id)) this.seedConversation(a._id);
      }
      const ids = new Set(accounts.map((a) => a._id));
      let list = [...this.conversations.values()].map((c) => c.conv).filter((c) => ids.has(c.accountId));
      if (req.query.platform) list = list.filter((c) => c.platform === req.query.platform);
      if (req.query.accountId) list = list.filter((c) => c.accountId === req.query.accountId);
      if (req.query.status) list = list.filter((c) => c.status === req.query.status);
      list.sort((a, b) => String(b.updatedTime).localeCompare(String(a.updatedTime)));
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      return { status: 200, body: { data: list.slice(0, limit), pagination: { hasMore: list.length > limit, nextCursor: null }, meta: { accountsQueried: accounts.length } } };
    });
    // getInboxConversationMessages — GET /v1/inbox/conversations/{conversationId}/messages
    this.route("GET", "/v1/inbox/conversations/{conversationId}/messages", "getInboxConversationMessages", (req) => {
      if (!req.query.accountId) return err(400, "accountId is required", { type: "invalid_request_error", code: "missing_required_field", param: "accountId" });
      const c = this.conversations.get(req.params.conversationId!);
      if (!c || c.conv.accountId !== req.query.accountId) return err(404, "Account or conversation not found");
      const msgs = req.query.sortOrder === "desc" ? [...c.messages].reverse() : c.messages;
      return { status: 200, body: { status: "success", messages: msgs, pagination: { hasMore: false, nextCursor: null }, sortOrderApplied: req.query.sortOrder === "desc" ? "desc" : "asc" } };
    });
    // sendInboxMessage — POST /v1/inbox/conversations/{conversationId}/messages
    this.route("POST", "/v1/inbox/conversations/{conversationId}/messages", "sendInboxMessage", (req) =>
      this.idempotent(req, () => {
        const accountId = typeof req.body?.accountId === "string" ? req.body.accountId : "";
        const text = typeof req.body?.message === "string" ? req.body.message : "";
        if (!accountId) return err(400, "accountId is required", { type: "invalid_request_error", code: "missing_required_field", param: "accountId" });
        if (!text.trim()) return err(400, "message is required", { type: "invalid_request_error", code: "missing_required_field", param: "message" });
        const c = this.conversations.get(req.params.conversationId!);
        if (!c || c.conv.accountId !== accountId) return err(404, "Account or conversation not found");
        const msg: ZernioInboxMessage = {
          id: `m_${this.id(`sent:${c.conv.id}:${c.messages.length}`)}`,
          conversationId: c.conv.id,
          accountId,
          platform: c.conv.platform,
          message: text,
          senderId: accountId,
          senderName: c.conv.accountUsername ?? null,
          direction: "outgoing",
          createdAt: new Date(this.now()).toISOString(),
        };
        c.messages.push(msg);
        c.conv.lastMessage = text;
        c.conv.updatedTime = msg.createdAt;
        return { status: 200, body: { success: true, data: { messageId: msg.id, conversationId: c.conv.id } } };
      }),
    );
    // markConversationRead — POST /v1/inbox/conversations/{conversationId}/read
    this.route("POST", "/v1/inbox/conversations/{conversationId}/read", "markConversationRead", (req) => {
      const accountId = typeof req.body?.accountId === "string" ? req.body.accountId : "";
      if (!accountId) return err(400, "accountId is required", { type: "invalid_request_error", code: "missing_required_field", param: "accountId" });
      const c = this.conversations.get(req.params.conversationId!);
      if (!c || c.conv.accountId !== accountId) return err(404, "Account or conversation not found");
      const marked = c.conv.unreadCount ?? 0;
      c.conv.unreadCount = 0;
      return { status: 200, body: { success: true, markedCount: marked } };
    });
    this.route("GET", "/v1/usage", "getUsage", (req) => {
      const profileId = req.query.profileId;
      if (profileId && !this.profiles.has(profileId)) return err(404, "Not found");
      const ads = profileId ? (this.managedAdsUsd.get(profileId) ?? 0) : [...this.managedAdsUsd.values()].reduce((a, b) => a + b, 0);
      return { status: 200, body: { supported: true, granularity: "total", days: [], totals: { accounts: 0, ads, total: ads }, lineItems: [], period: { source: "window" } } };
    });
  }

  private filterCampaigns(q: Record<string, string>): FakeCampaign[] {
    let list = [...this.campaigns.values()];
    if (q.profileId) list = list.filter((c) => c.profileId === q.profileId);
    if (q.accountId) list = list.filter((c) => c.accountId === q.accountId);
    if (q.adAccountId) {
      const ids = q.adAccountId.split(",");
      list = list.filter((c) => ids.includes(c.platformAdAccountId));
    }
    if (q.campaignId) {
      const ids = q.campaignId.split(",");
      list = list.filter((c) => ids.includes(c.platformCampaignId));
    }
    if (q.platform) list = list.filter((c) => c.platform === q.platform);
    return list.map((c) => ({ ...c, campaignBudget: c.budgetLevel === "campaign" ? c.budget : null }));
  }

  private daily(c: FakeCampaign, from?: string, to?: string): Array<Record<string, unknown>> {
    const end = to ? new Date(`${to}T00:00:00Z`) : new Date(this.now());
    const start = from ? new Date(`${from}T00:00:00Z`) : new Date(end.getTime() - 2 * 86_400_000);
    const out: Array<Record<string, unknown>> = [];
    for (let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); t <= end.getTime() && out.length < 31; t += 86_400_000) {
      out.push({ date: new Date(t).toISOString().slice(0, 10), spend: 12.5, impressions: 1000, clicks: 30, ctr: 3, conversions: 1.5, purchaseValue: 40 });
    }
    return out;
  }

  /** createStandaloneAd: validateOnly dry run (200) or the real create (201). */
  private createAd(req: FakeRequest): FakeResponse {
    const b = req.body ?? {};
    for (const f of ["accountId", "adAccountId", "name"]) {
      if (typeof b[f] !== "string" || !b[f]) return err(400, `${f} is required`, { type: "invalid_request_error", code: "missing_required_field", param: f });
    }
    const acct = this.accounts.get(String(b.accountId));
    if (!acct) return err(404, "Account ID not found.", { type: "not_found", code: "account_not_found", param: "accountId" });
    const adAccounts = this.adAccounts.get(acct._id) ?? [];
    if (!adAccounts.some((a) => a.id === b.adAccountId)) {
      return err(400, "adAccountId is not an ad account of this connection", { type: "invalid_request_error", code: "invalid_field_value", param: "adAccountId" });
    }
    const platform = campaignPlatformForAccount(acct.platform) ?? "facebook";
    const validateOnly = b.validateOnly === true;
    // MetaAdAccountWriteLimited: creates serialised per ad account, at most N
    // per rolling 5 minutes — validateOnly counts as a write.
    if (platform === "facebook" || platform === "instagram") {
      const key = String(b.adAccountId);
      const now = this.now();
      const recent = (this.metaWindow.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
      if (recent.length >= this.opts.metaCreatesPerWindow) {
        const retryAfter = Math.ceil((WINDOW_MS - (now - recent[0]!)) / 1000);
        return { status: 429, body: { error: "Too many ad creates for this Meta ad account; wait and send them sequentially.", type: "rate_limit_error", code: "rate_limited", platform: "meta" }, headers: { "retry-after": String(retryAfter) } };
      }
      recent.push(now);
      this.metaWindow.set(key, recent);
    }
    if (validateOnly) {
      if (!validateOnlySupported(platform, typeof b.campaignType === "string" ? b.campaignType : null)) {
        return err(501, "validateOnly is not available on this platform", { type: "invalid_request_error", code: "feature_not_available", platform });
      }
      const failure = this.validateFailure?.(b) ?? null;
      if (failure) return { status: 400, body: failure };
      return {
        status: 200,
        body: {
          validateOnly: true,
          results: [
            { node: "campaign", status: "validated" },
            { node: "adSet", status: "validated" },
            { node: "creative", status: "validated" },
            { node: "ad", status: "validated" },
          ],
          message: "Validation passed; nothing was created.",
        },
      };
    }
    return this.idempotent(req, () => {
      if (b.adSetId === undefined && (typeof b.budgetAmount !== "number" || !["daily", "lifetime"].includes(String(b.budgetType)))) {
        return err(400, "budgetAmount and budgetType are required", { type: "invalid_request_error", code: "missing_required_field", param: "budgetAmount" });
      }
      const held = b.status === "PAUSED" || b.campaignStatus === "PAUSED";
      const c = this.seedCampaign({
        accountId: acct._id,
        adAccountId: String(b.adAccountId),
        name: String(b.campaignName ?? `${String(b.name)} - Campaign`),
        budget: typeof b.budgetAmount === "number" ? { amount: b.budgetAmount, type: b.budgetType as "daily" | "lifetime" } : null,
        status: held ? "paused" : "active",
        spendPerDay: 0,
      });
      c.metrics = { spend: 0, impressions: 0, clicks: 0, ctr: 0, conversions: 0 };
      const ad = {
        _id: this.id("ad"),
        name: String(b.name),
        platform,
        status: held ? "paused" : "pending_review",
        platformCampaignId: c.platformCampaignId,
        platformAdSetId: `${c.platformCampaignId}1`,
        platformAdId: `${c.platformCampaignId}2`,
        platformAdAccountId: c.platformAdAccountId,
        budget: c.budget,
      };
      return { status: 201, body: { ad, message: "Ad created successfully" } };
    });
  }

  /** createPost: validates every platform target, replays by Idempotency-Key. */
  private createPost(req: FakeRequest): FakeResponse {
    const b = req.body ?? {};
    const isDraft = b.isDraft === true;
    const targets = Array.isArray(b.platforms) ? (b.platforms as Array<Record<string, unknown>>) : [];
    if (!isDraft && targets.length === 0) return err(400, "platforms is required for non-draft posts", { code: "missing_required_field", param: "platforms" });
    for (const t of targets) {
      const acct = this.accounts.get(String(t.accountId ?? ""));
      if (!acct || acct.platform !== t.platform) return err(400, `Account not found for platform ${String(t.platform)}`, { code: "account_not_found", param: "platforms" });
      if (accountCategory(acct.platform) === "ads") return err(400, "Account is not enabled for posting", { code: "ACCOUNT_NOT_ENABLED_FOR_POSTING" });
    }
    if (req.idempotencyKey) {
      // createPost's Idempotency-Key matches on the key alone (200 + original post).
      const prior = this.idem.get(`/v1/posts|${req.idempotencyKey}`);
      if (prior) return { status: 200, body: { ...(prior.res.body as object), message: "Post already exists (idempotent retry)" } };
    }
    const now = new Date(this.now()).toISOString();
    const publishNow = b.publishNow === true || (typeof b.scheduledFor === "string" && Date.parse(b.scheduledFor) <= this.now());
    const post: ZernioPostDoc & { profileIds: string[] } = {
      _id: this.id("post"),
      status: isDraft ? "draft" : publishNow ? "published" : "scheduled",
      scheduledFor: typeof b.scheduledFor === "string" ? b.scheduledFor : undefined,
      publishedAt: publishNow ? now : undefined,
      platforms: targets.map((t) => ({
        platform: String(t.platform),
        accountId: { _id: String(t.accountId) },
        status: publishNow ? "published" : "pending",
        ...(publishNow ? { publishedAt: now, platformPostUrl: `https://example.invalid/${String(t.platform)}/fake-post${MOCK.trim()}` } : {}),
      })),
      profileIds: targets.map((t) => this.accounts.get(String(t.accountId))!.profileId),
    };
    this.posts.set(post._id, post);
    const res: FakeResponse = { status: 201, body: { post, message: publishNow ? "Post published successfully" : "Post scheduled successfully" } };
    if (req.idempotencyKey) this.idem.set(`/v1/posts|${req.idempotencyKey}`, { bodyHash: hash(b), res });
    return res;
  }

  /** Move a scheduled post to published (what Zernio's scheduler does at scheduledFor). */
  publishDue(): number {
    let n = 0;
    for (const p of this.posts.values()) {
      if (p.status === "scheduled" && p.scheduledFor && Date.parse(p.scheduledFor) <= this.now()) {
        p.status = "published";
        p.publishedAt = new Date(this.now()).toISOString();
        for (const t of p.platforms ?? []) {
          t.status = "published";
          t.publishedAt = p.publishedAt;
          t.platformPostUrl = `https://example.invalid/${t.platform}/fake-post(MOCK)`;
        }
        n += 1;
      }
    }
    return n;
  }
}

/** Resolve stand-in for safeFetch's address check when the fake answers (no DNS, no network). */
export const fakeResolve = async (): Promise<string[]> => ["93.184.216.34"];
