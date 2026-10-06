// ShapesOS — Phase 15.4 (zernio): the Zernio REST client.
//
// One method per Zernio operation ShapesOS uses; each names its operationId
// and path from the OpenAPI spec (v1.217.1). The client knows nothing about
// workspaces — lib/zernio/tenancy.ts scopes every call to the workspace's
// profile and checks every id before it gets here.
//
// Cross-cutting rules (spec "Rate Limits", ErrorResponse, MetaAdAccountWriteLimited):
//   - Bearer API key (the platform key, ZERNIO_API_KEY); never in errors/logs.
//   - X-RateLimit-Limit / -Remaining / -Reset are read on every response and
//     kept on `lastRateLimit` — never hard-coded.
//   - Reads retry 429 / 5xx / network failures, waiting Retry-After (or a
//     short backoff), at most `maxReadRetries` times.
//   - Writes never retry blindly: a 429 means nothing was done, so it waits
//     Retry-After and retries ONCE (only when Retry-After ≤ 60 s — longer
//     waits come back as rate_limited with the seconds to wait). A 5xx or a
//     dropped connection on a write is retried only when the request carries
//     an Idempotency-Key (Zernio replays the original response); otherwise
//     the outcome is unknown and the error says so.
//   - validateOnly ad creates are writes too (Meta counts them as writes and
//     allows 30 creates per ad account per rolling 5 minutes, validateOnly
//     included): the same single-retry rule, never a loop.
//   - Every non-2xx body is the spec's ErrorResponse; the error keeps its
//     machine `code` and `details`, scrubbed of the key.
//
// Requests go through safeFetch (lib/connectors/safe-fetch.ts) like every
// connector: the base URL is an operator env var (ZERNIO_BASE_URL), so it is
// re-validated per request and redirects never carry the bearer elsewhere.

import { safeFetch } from "@/lib/connectors/safe-fetch";
import { ConnectorApiError, scrubMessage, type ConnectorErrorCode } from "@/lib/connectors/m21/live/http";
import type { ResolveFn } from "@/lib/safe-url";
import {
  ZERNIO_DEFAULT_BASE_URL,
  type ZernioAccountDoc,
  type ZernioAccountHealthRow,
  type ZernioAdAccountDoc,
  type ZernioCampaignAnalytics,
  type ZernioCampaignDoc,
  type ZernioErrorBody,
  type ZernioLiveCampaign,
  type ZernioPostDoc,
  type ZernioProfileDoc,
  type ZernioTimelineRow,
  type ZernioUsageMetering,
  type ZernioValidateResult,
  type ZernioInboxConversation,
  type ZernioInboxMessage,
} from "./spec";

export class ZernioError extends ConnectorApiError {
  /** ErrorResponse.code (e.g. feature_not_available, rate_limited, profile_name_conflict). */
  readonly zernioCode: string | null;
  /** Seconds the server asked us to wait (Retry-After), when it said. */
  readonly retryAfterSec: number | null;
  readonly details: Record<string, unknown> | null;
  readonly operationId: string;
  constructor(input: {
    operationId: string;
    code: ConnectorErrorCode;
    message: string;
    status?: number;
    zernioCode?: string | null;
    retryAfterSec?: number | null;
    details?: Record<string, unknown> | null;
  }) {
    super("Zernio", input.code, input.message, input.status);
    this.name = "ZernioError";
    this.operationId = input.operationId;
    this.zernioCode = input.zernioCode ?? null;
    this.retryAfterSec = input.retryAfterSec ?? null;
    this.details = input.details ?? null;
  }
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** X-RateLimit-Reset as sent (epoch seconds or a date). */
  reset: string | null;
}

export interface ZernioClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** "live" = the real API; "mock" = the labelled FAKE Zernio (lib/zernio/fake.ts). */
  mode: "live" | "mock";
  fetchImpl?: typeof fetch;
  resolve?: ResolveFn;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt for reads (default 2). */
  maxReadRetries?: number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface Op {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Query;
  body?: unknown;
  /** read = safe to retry; write = never retried blindly. */
  kind: "read" | "write";
  idempotencyKey?: string;
}

export interface ZernioResponse<T> {
  status: number;
  data: T;
}

/** The longest Retry-After a call will sit through before answering rate_limited. */
export const MAX_INLINE_RETRY_AFTER_SEC = 60;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseRetryAfterSec(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  return null;
}

function codeFor(status: number, body: ZernioErrorBody | null): ConnectorErrorCode {
  if (status === 401) return "auth_rejected";
  if (status === 429) return "rate_limited";
  if (status === 402 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 || status === 409 || status === 422 || status === 501) return "bad_request";
  if (body?.type === "rate_limit_error") return "rate_limited";
  return "provider_error";
}

function num(v: string | null): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class ZernioClient {
  readonly mode: "live" | "mock";
  readonly baseUrl: string;
  /** The last X-RateLimit-* headers seen (null until a response carried them). */
  lastRateLimit: RateLimitInfo | null = null;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly resolve?: ResolveFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxReadRetries: number;

  constructor(opts: ZernioClientOptions) {
    this.apiKey = opts.apiKey;
    this.mode = opts.mode;
    this.baseUrl = (opts.baseUrl ?? ZERNIO_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.resolve = opts.resolve;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxReadRetries = opts.maxReadRetries ?? 2;
  }

  private url(path: string, query?: Query): string {
    const u = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private noteRateLimit(res: Response): void {
    const limit = num(res.headers.get("x-ratelimit-limit"));
    const remaining = num(res.headers.get("x-ratelimit-remaining"));
    const reset = res.headers.get("x-ratelimit-reset");
    if (limit !== null || remaining !== null || reset) this.lastRateLimit = { limit, remaining, reset };
  }

  private error(op: Op, status: number, body: unknown, retryAfterSec: number | null): ZernioError {
    const b = body && typeof body === "object" ? (body as ZernioErrorBody) : null;
    const raw = b?.error ?? (typeof body === "string" ? body : "");
    const msg = scrubMessage(String(raw || `HTTP ${status}`), [this.apiKey]);
    return new ZernioError({
      operationId: op.operationId,
      code: codeFor(status, b),
      message: `Zernio ${op.operationId} failed (HTTP ${status})${msg ? `: ${msg}` : ""}`,
      status,
      zernioCode: typeof b?.code === "string" ? b.code : null,
      retryAfterSec,
      details: b?.details && typeof b.details === "object" ? b.details : null,
    });
  }

  /** One Zernio operation, with the read/write retry policy described above. */
  async call<T>(op: Op): Promise<ZernioResponse<T>> {
    const url = this.url(op.path, op.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    let body: string | undefined;
    if (op.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(op.body);
    }
    if (op.idempotencyKey) headers["Idempotency-Key"] = op.idempotencyKey.slice(0, 255);
    const maxRetries = op.kind === "read" ? this.maxReadRetries : 1;
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await safeFetch(url, { method: op.method, headers, body }, { fetchFn: this.fetchImpl, resolve: this.resolve });
      } catch {
        const retryable = op.kind === "read" || !!op.idempotencyKey;
        if (retryable && attempt < maxRetries) {
          await this.sleep(500 * 2 ** attempt);
          attempt += 1;
          continue;
        }
        throw new ZernioError({
          operationId: op.operationId,
          code: "provider_unreachable",
          message:
            op.kind === "write" && !op.idempotencyKey
              ? `Zernio could not be reached during ${op.operationId}; the outcome is unknown — check before trying again.`
              : `Zernio could not be reached (${op.operationId}).`,
        });
      }
      this.noteRateLimit(res);
      const text = await res.text().catch(() => "");
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (res.ok) return { status: res.status, data: parsed as T };

      const retryAfterSec = parseRetryAfterSec(res.headers.get("retry-after"));
      // 429: nothing was done — wait what the server says, then retry (reads
      // up to maxReadRetries; writes once). Never sit through more than 60 s.
      const inFlight409 = res.status === 409 && !!op.idempotencyKey && retryAfterSec !== null;
      if ((res.status === 429 || inFlight409) && attempt < maxRetries) {
        const wait = retryAfterSec ?? (op.kind === "read" ? 2 ** attempt : null);
        if (wait !== null && wait <= MAX_INLINE_RETRY_AFTER_SEC) {
          await this.sleep(wait * 1000);
          attempt += 1;
          continue;
        }
      }
      // 5xx: a read (or an idempotent write) may try again; a plain write's
      // outcome is unknown and is never repeated blindly.
      if (res.status >= 500 && res.status !== 501 && (op.kind === "read" || !!op.idempotencyKey) && attempt < maxRetries) {
        await this.sleep((retryAfterSec ?? 2 ** attempt) * 1000);
        attempt += 1;
        continue;
      }
      throw this.error(op, res.status, parsed, retryAfterSec);
    }
  }

  // ── Profiles ───────────────────────────────────────────────────────────

  /** listProfiles — GET /v1/profiles (name = exact-match filter). */
  async listProfiles(q: { name?: string } = {}): Promise<ZernioProfileDoc[]> {
    const r = await this.call<{ profiles?: ZernioProfileDoc[] }>({
      operationId: "listProfiles", method: "GET", path: "/v1/profiles", query: { name: q.name }, kind: "read",
    });
    return r.data?.profiles ?? [];
  }

  /**
   * createProfile — POST /v1/profiles. Names are unique per team; a duplicate
   * is a 409 whose details.existingProfileId names the existing profile. The
   * Idempotency-Key makes a retried create replay the original 201.
   */
  async createProfile(body: { name: string; description?: string }, idempotencyKey: string): Promise<ZernioProfileDoc> {
    const r = await this.call<{ profile?: ZernioProfileDoc }>({
      operationId: "createProfile", method: "POST", path: "/v1/profiles", body, kind: "write", idempotencyKey,
    });
    if (!r.data?.profile?._id) {
      throw new ZernioError({ operationId: "createProfile", code: "provider_error", message: "Zernio createProfile answered without a profile id." });
    }
    return r.data.profile;
  }

  /** getProfile — GET /v1/profiles/{profileId}. */
  async getProfile(profileId: string): Promise<ZernioProfileDoc> {
    const r = await this.call<{ profile: ZernioProfileDoc }>({
      operationId: "getProfile", method: "GET", path: `/v1/profiles/${encodeURIComponent(profileId)}`, kind: "read",
    });
    return r.data.profile;
  }

  // ── Accounts ───────────────────────────────────────────────────────────

  /** listAccounts — GET /v1/accounts?profileId=… (every status). */
  async listAccounts(q: { profileId: string; platform?: string; category?: string }): Promise<ZernioAccountDoc[]> {
    const r = await this.call<{ accounts?: ZernioAccountDoc[] }>({
      operationId: "listAccounts", method: "GET", path: "/v1/accounts", query: q, kind: "read",
    });
    return r.data?.accounts ?? [];
  }

  /** getAllAccountsHealth — GET /v1/accounts/health?profileId=…. */
  async getAllAccountsHealth(q: { profileId: string }): Promise<ZernioAccountHealthRow[]> {
    const r = await this.call<{ accounts?: ZernioAccountHealthRow[] }>({
      operationId: "getAllAccountsHealth", method: "GET", path: "/v1/accounts/health", query: q, kind: "read",
    });
    return r.data?.accounts ?? [];
  }

  // ── Connect ────────────────────────────────────────────────────────────

  /** getConnectUrl — GET /v1/connect/{platform}?profileId=&redirect_url= → { authUrl }. */
  async getConnectUrl(platform: string, q: { profileId: string; redirectUrl: string }): Promise<{ authUrl: string }> {
    const r = await this.call<{ authUrl?: string }>({
      operationId: "getConnectUrl", method: "GET", path: `/v1/connect/${encodeURIComponent(platform)}`,
      query: { profileId: q.profileId, redirect_url: q.redirectUrl }, kind: "read",
    });
    if (!r.data?.authUrl) throw new ZernioError({ operationId: "getConnectUrl", code: "provider_error", message: "Zernio returned no connect URL." });
    return { authUrl: r.data.authUrl };
  }

  /**
   * connectAds — GET /v1/connect/{platform}/ads → an authUrl, or
   * { alreadyConnected, accountId } when the ads connection exists (one per profile).
   */
  async connectAds(
    platform: string,
    q: { profileId: string; redirectUrl: string; accountId?: string },
  ): Promise<{ authUrl?: string; alreadyConnected?: boolean; accountId?: string }> {
    const r = await this.call<{ authUrl?: string; alreadyConnected?: boolean; accountId?: string }>({
      operationId: "connectAds", method: "GET", path: `/v1/connect/${encodeURIComponent(platform)}/ads`,
      query: { profileId: q.profileId, redirect_url: q.redirectUrl, accountId: q.accountId }, kind: "read",
    });
    return r.data ?? {};
  }

  /** connectOpenAIAdsCredentials — POST /v1/connect/openai-ads/credentials (the customer's own key, passed through). */
  async connectOpenAIAdsCredentials(body: { apiKey: string; profileId: string }): Promise<{ accountId?: string; adAccountName?: string }> {
    const r = await this.call<{ accountId?: string; adAccountName?: string }>({
      operationId: "connectOpenAIAdsCredentials", method: "POST", path: "/v1/connect/openai-ads/credentials", body, kind: "write",
    });
    return r.data ?? {};
  }

  // ── Ads ────────────────────────────────────────────────────────────────

  /** listAdAccounts — GET /v1/ads/accounts?accountId=… */
  async listAdAccounts(q: { accountId: string }): Promise<ZernioAdAccountDoc[]> {
    const r = await this.call<{ accounts?: ZernioAdAccountDoc[] }>({
      operationId: "listAdAccounts", method: "GET", path: "/v1/ads/accounts", query: q, kind: "read",
    });
    return r.data?.accounts ?? [];
  }

  /** getAdAccountLiveEntities — GET /v1/ads/accounts/live (Meta only; live budgets). */
  async getAdAccountLiveCampaigns(q: { accountId: string; adAccountId: string; after?: string }): Promise<{
    campaigns: ZernioLiveCampaign[];
    currency: string | null;
    after: string | null;
  }> {
    const r = await this.call<{ campaigns?: ZernioLiveCampaign[]; currency?: string; paging?: { campaigns?: { after?: string | null } } }>({
      operationId: "getAdAccountLiveEntities", method: "GET", path: "/v1/ads/accounts/live",
      query: { accountId: q.accountId, adAccountId: q.adAccountId, level: "campaign", limit: 500, after: q.after }, kind: "read",
    });
    return { campaigns: r.data?.campaigns ?? [], currency: r.data?.currency ?? null, after: r.data?.paging?.campaigns?.after ?? null };
  }

  /** listAdCampaigns — GET /v1/ads/campaigns (profileId-scoped). */
  async listAdCampaigns(q: {
    profileId: string;
    campaignId?: string;
    platform?: string;
    accountId?: string;
    adAccountId?: string;
    page?: number;
    limit?: number;
  }): Promise<ZernioCampaignDoc[]> {
    const r = await this.call<{ campaigns?: ZernioCampaignDoc[] }>({
      operationId: "listAdCampaigns", method: "GET", path: "/v1/ads/campaigns", query: q, kind: "read",
    });
    return r.data?.campaigns ?? [];
  }

  /** getAdTree — GET /v1/ads/tree (profileId-scoped; timeIncrement=1 adds daily[]). */
  async getAdTree(q: {
    profileId: string;
    campaignId?: string;
    accountId?: string;
    adAccountId?: string;
    fromDate?: string;
    toDate?: string;
    timeIncrement?: 1;
    page?: number;
    limit?: number;
  }): Promise<{ campaigns: ZernioCampaignDoc[]; pages: number | null }> {
    const r = await this.call<{ campaigns?: ZernioCampaignDoc[]; pagination?: { pages?: number } }>({
      operationId: "getAdTree", method: "GET", path: "/v1/ads/tree", query: q, kind: "read",
    });
    return { campaigns: r.data?.campaigns ?? [], pages: r.data?.pagination?.pages ?? null };
  }

  /** getCampaignAnalytics — GET /v1/ads/campaigns/{campaignId}/analytics. */
  async getCampaignAnalytics(campaignId: string, q: { platform?: string; fromDate?: string; toDate?: string }): Promise<ZernioCampaignAnalytics> {
    const r = await this.call<ZernioCampaignAnalytics>({
      operationId: "getCampaignAnalytics", method: "GET", path: `/v1/ads/campaigns/${encodeURIComponent(campaignId)}/analytics`, query: q, kind: "read",
    });
    return r.data ?? {};
  }

  /**
   * createStandaloneAd — POST /v1/ads/create. With validateOnly: true it is
   * the dry run (200, nothing created); without it, the real create (201).
   * Callers go through lib/zernio/ads.ts, which never sends a real create
   * without a passing (or platform-unsupported) dry run of the same body.
   */
  async createStandaloneAd(body: Record<string, unknown>, opts: { idempotencyKey?: string } = {}): Promise<ZernioResponse<unknown>> {
    return this.call({
      operationId: "createStandaloneAd", method: "POST", path: "/v1/ads/create", body, kind: "write",
      idempotencyKey: body.validateOnly === true ? undefined : opts.idempotencyKey,
    });
  }

  /** The dry-run half of createStandaloneAd (validateOnly: true). */
  async validateStandaloneAd(body: Record<string, unknown>): Promise<ZernioValidateResult> {
    const r = await this.createStandaloneAd({ ...body, validateOnly: true });
    return (r.data ?? { validateOnly: true }) as ZernioValidateResult;
  }

  /** updateAdCampaignStatus — PUT /v1/ads/campaigns/{campaignId}/status { status, platform }. */
  async updateAdCampaignStatus(campaignId: string, body: { status: "active" | "paused"; platform: string }): Promise<Record<string, unknown>> {
    const r = await this.call<Record<string, unknown>>({
      operationId: "updateAdCampaignStatus", method: "PUT", path: `/v1/ads/campaigns/${encodeURIComponent(campaignId)}/status`, body, kind: "write",
    });
    return r.data ?? {};
  }

  /** updateAdCampaign — PUT /v1/ads/campaigns/{campaignId} { platform, budget }. */
  async updateAdCampaignBudget(campaignId: string, body: { platform: string; budget: { amount: number; type: "daily" | "lifetime" } }): Promise<Record<string, unknown>> {
    const r = await this.call<Record<string, unknown>>({
      operationId: "updateAdCampaign", method: "PUT", path: `/v1/ads/campaigns/${encodeURIComponent(campaignId)}`, body, kind: "write",
    });
    return r.data ?? {};
  }

  /** listLeadForms — GET /v1/ads/lead-forms?accountId=… */
  async listLeadForms(q: { accountId: string; adAccountId?: string }): Promise<unknown[]> {
    const r = await this.call<{ forms?: unknown[] }>({
      operationId: "listLeadForms", method: "GET", path: "/v1/ads/lead-forms", query: q, kind: "read",
    });
    return r.data?.forms ?? [];
  }

  /** createLeadForm — POST /v1/ads/lead-forms (NOT idempotent: never retried). */
  async createLeadForm(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.call<Record<string, unknown>>({
      operationId: "createLeadForm", method: "POST", path: "/v1/ads/lead-forms", body, kind: "write",
    });
    return r.data ?? {};
  }

  /** listAdAudiences — GET /v1/ads/audiences?accountId=&adAccountId= */
  async listAdAudiences(q: { accountId: string; adAccountId: string }): Promise<unknown[]> {
    const r = await this.call<{ audiences?: unknown[] }>({
      operationId: "listAdAudiences", method: "GET", path: "/v1/ads/audiences", query: q, kind: "read",
    });
    return r.data?.audiences ?? [];
  }

  /** createAdAudience — POST /v1/ads/audiences ("Create is not idempotent, never auto-retry"). */
  async createAdAudience(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.call<Record<string, unknown>>({
      operationId: "createAdAudience", method: "POST", path: "/v1/ads/audiences", body, kind: "write",
    });
    return r.data ?? {};
  }

  // ── Posts ──────────────────────────────────────────────────────────────

  /** createPost — POST /v1/posts (Idempotency-Key: a retry returns the original post). */
  async createPost(body: Record<string, unknown>, idempotencyKey: string): Promise<{ status: number; post: ZernioPostDoc | null; error?: string }> {
    const r = await this.call<{ post?: ZernioPostDoc; error?: string }>({
      operationId: "createPost", method: "POST", path: "/v1/posts", body, kind: "write", idempotencyKey,
    });
    return { status: r.status, post: r.data?.post ?? null, error: r.data?.error };
  }

  /** getPost — GET /v1/posts/{postId}. */
  async getPost(postId: string): Promise<ZernioPostDoc> {
    const r = await this.call<{ post: ZernioPostDoc }>({
      operationId: "getPost", method: "GET", path: `/v1/posts/${encodeURIComponent(postId)}`, kind: "read",
    });
    return r.data.post;
  }

  /** getPostTimeline — GET /v1/analytics/post-timeline?postId=… */
  async getPostTimeline(postId: string, q: { fromDate?: string; toDate?: string } = {}): Promise<ZernioTimelineRow[]> {
    const r = await this.call<{ timeline?: ZernioTimelineRow[] }>({
      operationId: "getPostTimeline", method: "GET", path: "/v1/analytics/post-timeline", query: { postId, ...q }, kind: "read",
    });
    return r.data?.timeline ?? [];
  }

  /** getMediaPresignedUrl — POST /v1/media/presign → { uploadUrl, publicUrl }. */
  async getMediaPresignedUrl(body: { filename: string; contentType: string; size?: number }): Promise<{ uploadUrl: string; publicUrl: string }> {
    const r = await this.call<{ uploadUrl?: string; publicUrl?: string }>({
      operationId: "getMediaPresignedUrl", method: "POST", path: "/v1/media/presign", body, kind: "write",
    });
    if (!r.data?.uploadUrl || !r.data.publicUrl) {
      throw new ZernioError({ operationId: "getMediaPresignedUrl", code: "provider_error", message: "Zernio returned no upload URL." });
    }
    return { uploadUrl: r.data.uploadUrl, publicUrl: r.data.publicUrl };
  }

  /** PUT the bytes to the presigned URL (cloud storage — no Zernio bearer token). */
  async uploadToPresignedUrl(uploadUrl: string, bytes: Uint8Array, contentType: string): Promise<void> {
    let res: Response;
    try {
      res = await safeFetch(
        uploadUrl,
        { method: "PUT", headers: { "Content-Type": contentType }, body: bytes as unknown as BodyInit },
        { fetchFn: this.fetchImpl, resolve: this.resolve },
      );
    } catch {
      throw new ZernioError({ operationId: "uploadMedia", code: "provider_unreachable", message: "The Zernio media upload could not be reached." });
    }
    if (!res.ok) throw new ZernioError({ operationId: "uploadMedia", code: "provider_error", message: `The Zernio media upload failed (HTTP ${res.status}).`, status: res.status });
  }

  // ── Inbox (Phase 18.2, WS=comms: the Mail app's social DMs) ─────────────
  // Spec "Messages" group (v1.217.1). Reads retry like every read; a send is
  // a write with an Idempotency-Key (a retry after a lost response replays
  // instead of sending twice). Callers scope every call to the workspace's
  // profile and mirrored accounts (lib/comms/mail/social.server.ts).

  /** listInboxConversations — GET /v1/inbox/conversations?profileId=… */
  async listInboxConversations(q: { profileId: string; platform?: string; status?: "active" | "archived"; limit?: number; cursor?: string; accountId?: string }): Promise<{ conversations: ZernioInboxConversation[]; nextCursor: string | null }> {
    const r = await this.call<{ data?: ZernioInboxConversation[]; pagination?: { nextCursor?: string | null } }>({
      operationId: "listInboxConversations", method: "GET", path: "/v1/inbox/conversations", query: { ...q, sortOrder: "desc" }, kind: "read",
    });
    return { conversations: r.data?.data ?? [], nextCursor: r.data?.pagination?.nextCursor ?? null };
  }

  /** getInboxConversationMessages — GET /v1/inbox/conversations/{id}/messages?accountId=… (side-effect free). */
  async getInboxConversationMessages(conversationId: string, q: { accountId: string; limit?: number; sortOrder?: "asc" | "desc" }): Promise<ZernioInboxMessage[]> {
    const r = await this.call<{ messages?: ZernioInboxMessage[] }>({
      operationId: "getInboxConversationMessages", method: "GET", path: `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
      query: { accountId: q.accountId, limit: q.limit ?? 100, sortOrder: q.sortOrder ?? "asc" }, kind: "read",
    });
    return r.data?.messages ?? [];
  }

  /** sendInboxMessage — POST /v1/inbox/conversations/{id}/messages { accountId, message } (Idempotency-Key). */
  async sendInboxMessage(conversationId: string, body: { accountId: string; message: string }, idempotencyKey: string): Promise<{ messageId: string | null }> {
    const r = await this.call<{ success?: boolean; data?: { messageId?: string } }>({
      operationId: "sendInboxMessage", method: "POST", path: `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, body, kind: "write", idempotencyKey,
    });
    return { messageId: r.data?.data?.messageId ?? null };
  }

  /** markConversationRead — POST /v1/inbox/conversations/{id}/read { accountId } (a person opened it). */
  async markConversationRead(conversationId: string, body: { accountId: string }): Promise<{ markedCount: number }> {
    const r = await this.call<{ markedCount?: number }>({
      operationId: "markConversationRead", method: "POST", path: `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/read`, body, kind: "write",
    });
    return { markedCount: r.data?.markedCount ?? 0 };
  }

  // ── Usage ──────────────────────────────────────────────────────────────

  /** getUsage (metering mode) — GET /v1/usage?range=…&granularity=total&profileId=… (USD). */
  async getUsageMetering(q: { range: "cycle" | "prev-cycle" | "custom"; profileId?: string; from?: string; to?: string }): Promise<ZernioUsageMetering> {
    const r = await this.call<ZernioUsageMetering>({
      operationId: "getUsage", method: "GET", path: "/v1/usage", query: { ...q, granularity: "total" }, kind: "read",
    });
    return r.data ?? {};
  }
}
