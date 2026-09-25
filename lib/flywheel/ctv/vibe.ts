// Marketr — Phase 7 F4: Vibe.co adapter.
//
// Vibe.co is the only true programmatic CTV buy path in 2026. Adapter
// depth (spec §2/F4, decision 12.4): campaign CRUD + PAUSE + reporting
// ONLY. Budget moves are NOT in the adapter — any budget-move attempt is
// REJECTED and routed to F1's reallocation machinery.
//
// VERIFIED 2026-09-25 against the live public spec (https://cdn.apps.vibe.co/
// open-api/public-api/2026-06-01/latest.yaml, manifest generated 2026-09-24,
// docs portal https://developers.vibe.co):
//   - base: https://api.vibe.co ; pinned revision "2026-06-01" via the
//     X-Vibe-Revision header (the API is weeks old — version-pin aggressively)
//   - auth: OAuth2 client-credentials (token https://api.vibe.co/oauth2/token)
//     with scopes (campaigns:read/write/publish, reporting:read), or bearer JWT
//   - lifecycle: POST /campaigns/{id}/actions { action: PAUSE | PUBLISH | ACTIVATE }
//   - campaigns: GET/POST /campaigns, GET/PATCH/DELETE /campaigns/{id}
//   - BUDGETS LIVE ON STRATEGIES: a Campaign is a container; Strategies carry
//     budget + budget_type (DAILY|GLOBAL), schedule, targeting, creatives.
//     That is precisely why budget moves route through F1.
//   - reporting: POST /reports (async) → poll GET /reports/{report_id}
//   - rate limits: campaign actions 2/s burst, 30/m steady
//
// Fake/test mode is the default: without creds the adapter fails closed
// with an honest not-configured error + setup guidance; with test mode on,
// mutating calls simulate against a local fake and NEVER touch api.vibe.co.

import type { CtvStore } from "./store";

/** Pinned OpenAPI revision — verified live 2026-09-25. */
export const VIBE_API_REVISION = "2026-06-01";
export const VIBE_API_BASE = "https://api.vibe.co";
export const VIBE_DOCS_URL = "https://developers.vibe.co";
export const VIBE_SPEC_MANIFEST_URL = "https://cdn.apps.vibe.co/open-api/public-api/manifest.json";
export const VIBE_API_VERIFIED_AT = "2026-09-25";

export const VIBE_SCOPES = [
  "campaigns:read",
  "campaigns:write",
  "campaigns:publish",
  "reporting:read",
] as const;

export class VibeNotConfiguredError extends Error {
  readonly code = "vibe_not_configured";
  constructor() {
    super(
      "Vibe is not connected: no credentials found. " +
      "Connect your Vibe account (Settings → Flywheel → Vibe) to buy programmatically, " +
      "or use the concierge IO path for MNTN/Roku/Tatari/tvScientific. " +
      "Required env: VIBE_CLIENT_ID + VIBE_CLIENT_SECRET (OAuth2 client credentials), " +
      "or VIBE_API_TOKEN (bearer). See https://developers.vibe.co for setup.",
    );
    this.name = "VibeNotConfiguredError";
  }
}

export class VibeBudgetMoveRejectedError extends Error {
  readonly code = "vibe_budget_move_rejected";
  readonly f1Route = "POST /api/flywheel/reallocation/proposals";
  constructor(detail: string) {
    super(
      `Budget moves do not go through the Vibe adapter — they route through F1's reallocation machinery ` +
      `(optimizer → policy engine → executor). Attempt: ${detail}. ` +
      `Use ${"POST /api/flywheel/reallocation/proposals"} instead.`,
    );
    this.name = "VibeBudgetMoveRejectedError";
  }
}

export interface VibeConfig {
  /** true → simulate locally, never touch api.vibe.co. DEFAULT. */
  testMode: boolean;
  clientId: string | null;
  clientSecret: string | null;
  apiToken: string | null;
  revision: string;
}

export function resolveVibeConfig(env: NodeJS.ProcessEnv = process.env): VibeConfig {
  const clientId = env.VIBE_CLIENT_ID ?? null;
  const clientSecret = env.VIBE_CLIENT_SECRET ?? null;
  const apiToken = env.VIBE_API_TOKEN ?? null;
  // Test mode is the DEFAULT. Real calls require VIBE_TEST_MODE=false AND creds.
  const testMode = (env.VIBE_TEST_MODE ?? "true").toLowerCase() !== "false";
  return { testMode, clientId, clientSecret, apiToken, revision: VIBE_API_REVISION };
}

export function assertVibeConfigured(cfg: VibeConfig): void {
  if (cfg.testMode) return; // test mode needs no creds
  if (!cfg.clientId || !cfg.clientSecret) {
    if (!cfg.apiToken) throw new VibeNotConfiguredError();
  }
}

export type VibeLifecycleAction = "PAUSE" | "PUBLISH" | "ACTIVATE";

export interface VibeCampaignInput {
  advertiserId: string;
  name: string;
  objective?: string;
  /** Creation-time budget is a buy parameter bound by the approval object —
   *  post-creation budget CHANGES are the rejected budget moves. */
  strategyBudgetCents?: number;
  strategyBudgetType?: "DAILY" | "GLOBAL";
  approvalObjectId: string;
}

export interface VibeCampaign {
  id: string;
  name: string;
  advertiserId: string;
  status: string;
  testMode: boolean;
  revision: string;
  paused: boolean;
  raw?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Test-mode fake: simulates the API surface locally. Never network.
// ---------------------------------------------------------------------------

class VibeTestFake {
  private campaigns = new Map<string, VibeCampaign & { paused: boolean }>();
  private n = 0;
  private log: { op: string; at: string }[] = [];

  private touch(op: string) {
    this.log.push({ op, at: new Date().toISOString() });
  }

  listAdvertisers() {
    this.touch("listAdvertisers");
    return [{ id: "adv_test_001", name: "Test Advertiser (fake)", testMode: true }];
  }

  createCampaign(input: VibeCampaignInput): VibeCampaign {
    this.touch("createCampaign");
    this.n++;
    const id = `vibe_test_camp_${this.n}`;
    const c = { id, name: input.name, advertiserId: input.advertiserId, status: "DRAFT", paused: false, testMode: true, revision: VIBE_API_REVISION };
    this.campaigns.set(id, c);
    return c;
  }

  getCampaign(id: string): VibeCampaign {
    this.touch("getCampaign");
    const c = this.campaigns.get(id);
    if (!c) throw new Error(`Vibe (test) campaign not found: ${id}`);
    return c;
  }

  updateCampaign(id: string, patch: { name?: string }): VibeCampaign {
    this.touch("updateCampaign");
    const c = this.getCampaign(id);
    const next = { ...c, ...(patch.name ? { name: patch.name } : {}) };
    this.campaigns.set(id, next);
    return next;
  }

  action(id: string, action: VibeLifecycleAction): VibeCampaign {
    this.touch(`action:${action}`);
    const c = this.getCampaign(id);
    const next = { ...c, paused: action === "PAUSE", status: action === "PAUSE" ? "PAUSED" : action === "PUBLISH" ? "PUBLISHED" : "ACTIVE" };
    this.campaigns.set(id, next);
    return next;
  }

  report(id: string): Record<string, unknown> {
    this.touch("report");
    this.getCampaign(id);
    return {
      campaignId: id,
      testMode: true,
      note: "Test-mode reporting fixture — not real delivery data.",
      impressions: 0,
      spendCents: 0,
    };
  }

  get opLog() { return [...this.log]; }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class VibeAdapter {
  private cfg: VibeConfig;
  private fake = new VibeTestFake();
  private token: string | null = null;
  private fetchImpl: typeof fetch;

  constructor(cfg: VibeConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  get testMode(): boolean { return this.cfg.testMode; }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Vibe-Revision": this.cfg.revision,
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  private async ensureToken(): Promise<void> {
    if (this.cfg.testMode) return;
    if (this.token) return;
    if (this.cfg.apiToken) {
      this.token = this.cfg.apiToken;
      return;
    }
    // OAuth2 client credentials.
    const res = await this.fetchImpl(`${VIBE_API_BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.cfg.clientId!,
        client_secret: this.cfg.clientSecret!,
        scope: [...VIBE_SCOPES].join(" "),
      }),
    });
    if (!res.ok) throw new Error(`Vibe token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new Error("Vibe token request returned no access_token");
    this.token = body.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.cfg.testMode) {
      throw new Error("Internal: live call attempted in test mode — this is a bug");
    }
    await this.ensureToken();
    const res = await this.fetchImpl(`${VIBE_API_BASE}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      throw new Error("Vibe rate limit hit (provider_rate_limit_stop) — backing off; no retry in this task");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Vibe API ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  // -- read paths -----------------------------------------------------------
  async listAdvertisers() {
    if (this.cfg.testMode) return this.fake.listAdvertisers();
    assertVibeConfigured(this.cfg);
    return this.call("GET", "/advertisers");
  }

  async listCampaigns(advertiserId?: string) {
    if (this.cfg.testMode) return [];
    assertVibeConfigured(this.cfg);
    const q = advertiserId ? `?advertiser_id=${encodeURIComponent(advertiserId)}` : "";
    return this.call("GET", `/campaigns${q}`);
  }

  async getCampaign(campaignId: string): Promise<VibeCampaign> {
    if (this.cfg.testMode) return this.fake.getCampaign(campaignId);
    assertVibeConfigured(this.cfg);
    return this.call("GET", `/campaigns/${encodeURIComponent(campaignId)}`);
  }

  // -- write paths: every one requires an approval object id ----------------
  private requireApproval(approvalObjectId: string | undefined, what: string): void {
    if (!approvalObjectId) {
      throw new Error(`Vibe ${what} refused: a Phase 5 per-buy approval object id is required (every dollar stays human-signed)`);
    }
  }

  async createCampaign(input: VibeCampaignInput): Promise<VibeCampaign> {
    this.requireApproval(input.approvalObjectId, "createCampaign");
    if (this.cfg.testMode) return this.fake.createCampaign(input);
    assertVibeConfigured(this.cfg);
    // NOTE: strategy budget at creation is a buy parameter, bound by the
    // approval object — it is not a "budget move". Post-creation budget
    // changes go through F1 (see rejectBudgetMove).
    return this.call("POST", "/campaigns", {
      name: input.name,
      advertiser_id: input.advertiserId,
      objective: input.objective ?? "CONVERSIONS",
      ...(input.strategyBudgetCents !== undefined
        ? { strategies: [{ budget: input.strategyBudgetCents / 100, budget_type: input.strategyBudgetType ?? "DAILY" }] }
        : {}),
    });
  }

  async updateCampaign(campaignId: string, patch: { name?: string }, approvalObjectId: string): Promise<VibeCampaign> {
    this.requireApproval(approvalObjectId, "updateCampaign");
    if ("budget" in (patch as Record<string, unknown>)) {
      throw new VibeBudgetMoveRejectedError("updateCampaign with budget");
    }
    if (this.cfg.testMode) return this.fake.updateCampaign(campaignId, patch);
    assertVibeConfigured(this.cfg);
    return this.call("PATCH", `/campaigns/${encodeURIComponent(campaignId)}`, patch);
  }

  /** Real pause via the Vibe API (PAUSE lifecycle action). */
  async pauseCampaign(campaignId: string, approvalObjectId: string): Promise<VibeCampaign> {
    this.requireApproval(approvalObjectId, "pauseCampaign");
    if (this.cfg.testMode) return this.fake.action(campaignId, "PAUSE");
    assertVibeConfigured(this.cfg);
    return this.call("POST", `/campaigns/${encodeURIComponent(campaignId)}/actions`, { action: "PAUSE" });
  }

  async publishCampaign(campaignId: string, approvalObjectId: string): Promise<VibeCampaign> {
    this.requireApproval(approvalObjectId, "publishCampaign");
    if (this.cfg.testMode) return this.fake.action(campaignId, "PUBLISH");
    assertVibeConfigured(this.cfg);
    return this.call("POST", `/campaigns/${encodeURIComponent(campaignId)}/publish`, {});
  }

  async deleteCampaign(campaignId: string, approvalObjectId: string): Promise<void> {
    this.requireApproval(approvalObjectId, "deleteCampaign");
    if (this.cfg.testMode) { this.fake.action(campaignId, "PAUSE"); return; }
    assertVibeConfigured(this.cfg);
    await this.call("DELETE", `/campaigns/${encodeURIComponent(campaignId)}`);
  }

  // -- reporting --------------------------------------------------------------
  async campaignReport(campaignId: string): Promise<Record<string, unknown>> {
    if (this.cfg.testMode) return this.fake.report(campaignId);
    assertVibeConfigured(this.cfg);
    const created = await this.call<{ id?: string }>("POST", "/reports", {
      report_type: "campaign_performance",
      campaign_id: campaignId,
    });
    if (!created.id) throw new Error("Vibe report creation returned no report id");
    return this.call("GET", `/reports/${encodeURIComponent(created.id)}`);
  }

  // -- BUDGET MOVES: REJECTED, ROUTED TO F1 -----------------------------------
  /**
   * Any budget adjustment — daily/global strategy budget changes, budget
   * reallocations, bid changes that move money — is rejected here and routed
   * to F1's reallocation machinery (optimizer → policy engine → executor).
   * The adapter never moves money between budgets; it is load-bearing for
   * the three-plane separation.
   */
  rejectBudgetMove(store: CtvStore | null, workspaceId: string, actor: string, detail: string): never {
    const err = new VibeBudgetMoveRejectedError(detail);
    // Audit the rejection (fire-and-forget: the throw is the contract).
    if (store) {
      void store.audit({
        workspaceId, actor, action: "vibe_budget_move_rejected",
        subjectType: "adapter", subjectId: "vibe",
        detail: { detail, routedTo: err.f1Route },
      }).catch(() => {});
    }
    throw err;
  }

  /** Test-mode op log (proves test mode never touched the network). */
  get testOpLog() { return this.fake.opLog; }
}

export function createVibeAdapter(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): VibeAdapter {
  return new VibeAdapter(resolveVibeConfig(env), fetchImpl);
}
