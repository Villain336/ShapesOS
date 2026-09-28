// Marketr — Phase 14: Composio hosted action layer (HTTP boundary).
//
// Composio v3 REST (base https://backend.composio.dev/api/v3, header
// x-api-key). Endpoints used (verified 2026-09-28):
//   GET  /tools?toolkit_slug=&search=   — tool catalog
//   GET  /tools/:slug                   — tool schema
//   POST /tools/execute/:slug           — execute {connected_account_id,
//                                          user_id?, version, arguments}
//   GET  /connected_accounts            — list connections
//   POST /auth_configs                  — create managed-OAuth auth config
//   POST /connected_accounts/link       — mint OAuth connect link
//                                          (redirect_url expires ~12 min —
//                                          mint fresh on demand, never cache)
//
// Trust boundary (locked): Composio HOSTED. Marketr stores only the opaque
// connected_account_id per workspace — never raw OAuth tokens.
//
// This module is the ONLY place that talks to Composio. Everything else
// goes through lib/integrations/actions/*. Verification is fixture-based:
// inject a mock ComposioHttp — no real API key, no network in tests.

export class ComposioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposioConfigError";
  }
}

export class ComposioApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`Composio API ${status}: ${message}`);
    this.name = "ComposioApiError";
    this.status = status;
  }
}

const DEFAULT_BASE_URL = "https://backend.composio.dev/api/v3";

/** Fail-closed: no key, no calls. Never ask for keys in chat — the key
 *  comes from the environment (BYO for self-hosted, bundled for hosted). */
export function getComposioApiKey(): string {
  const key = process.env.COMPOSIO_API_KEY?.trim();
  if (!key) {
    throw new ComposioConfigError(
      "COMPOSIO_API_KEY is not set. Connect a Composio key in Settings → Integrations → Actions first.",
    );
  }
  return key;
}

export function getComposioBaseUrl(): string {
  return process.env.COMPOSIO_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

export interface ComposioHttp {
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
}

/** Default fetch-based HTTP client. Swappable for fixtures. */
export function createComposioHttp(): ComposioHttp {
  const baseUrl = getComposioBaseUrl();
  const apiKey = getComposioApiKey();
  return {
    async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
      const res = await fetch(`${baseUrl}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
        },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        const msg =
          (data as Record<string, unknown> | null)?.error ??
          (data as Record<string, unknown> | null)?.message ??
          text.slice(0, 200);
        throw new ComposioApiError(res.status, String(msg));
      }
      return data as T;
    },
  };
}

// ---------------------------------------------------------------------------
// Types (subset of the v3 shapes we consume)
// ---------------------------------------------------------------------------

export interface ComposioToolSummary {
  slug: string;
  name: string;
  description?: string;
  toolkit?: { slug: string; name?: string };
}

export interface ComposioExecuteResult {
  successful: boolean;
  data: unknown;
  error: unknown;
}

export interface ComposioConnectedAccount {
  id: string;
  status?: string;
  toolkit?: { slug: string };
  created_at?: string;
}

export interface ComposioConnectLink {
  link_token: string;
  redirect_url: string;
  expires_at?: string;
  connected_account_id?: string;
}

// ---------------------------------------------------------------------------
// Boundary functions — all take an injectable http (default: real client)
// ---------------------------------------------------------------------------

export async function listComposioTools(
  opts: { toolkitSlug?: string; search?: string; limit?: number },
  http: ComposioHttp = createComposioHttp(),
): Promise<ComposioToolSummary[]> {
  const q = new URLSearchParams();
  if (opts.toolkitSlug) q.set("toolkit_slug", opts.toolkitSlug);
  if (opts.search) q.set("search", opts.search);
  if (opts.limit) q.set("limit", String(opts.limit));
  const data = (await http.request<{ items?: ComposioToolSummary[]; tools?: ComposioToolSummary[] }>(
    `/tools${q.toString() ? `?${q}` : ""}`,
  )) as { items?: ComposioToolSummary[]; tools?: ComposioToolSummary[] };
  return data.items ?? data.tools ?? [];
}

export async function getComposioTool(
  slug: string,
  http: ComposioHttp = createComposioHttp(),
): Promise<ComposioToolSummary> {
  return http.request<ComposioToolSummary>(`/tools/${encodeURIComponent(slug)}`);
}

export async function executeComposioTool(
  opts: {
    slug: string;
    connectedAccountId: string;
    userId?: string;
    args: Record<string, unknown>;
  },
  http: ComposioHttp = createComposioHttp(),
): Promise<ComposioExecuteResult> {
  const body: Record<string, unknown> = {
    connected_account_id: opts.connectedAccountId,
    version: "latest",
    arguments: opts.args,
  };
  if (opts.userId) body.user_id = opts.userId;
  return http.request<ComposioExecuteResult>(`/tools/execute/${encodeURIComponent(opts.slug)}`, {
    method: "POST",
    body,
  });
}

export async function listComposioConnectedAccounts(
  http: ComposioHttp = createComposioHttp(),
): Promise<ComposioConnectedAccount[]> {
  const data = (await http.request<{ items?: ComposioConnectedAccount[] }>(
    `/connected_accounts`,
  )) as { items?: ComposioConnectedAccount[] };
  return data.items ?? [];
}

export async function createComposioAuthConfig(
  toolkitSlug: string,
  name: string,
  http: ComposioHttp = createComposioHttp(),
): Promise<{ id: string }> {
  const data = (await http.request<{ auth_config?: { id: string }; id?: string }>(
    `/auth_configs`,
    {
      method: "POST",
      body: {
        toolkit: { slug: toolkitSlug },
        auth_config: { type: "use_composio_managed_auth", name },
      },
    },
  )) as { auth_config?: { id: string }; id?: string };
  const id = data.auth_config?.id ?? data.id;
  if (!id) throw new ComposioApiError(500, "auth config creation returned no id");
  return { id };
}

export async function getComposioAuthConfigId(
  toolkitSlug: string,
  http: ComposioHttp = createComposioHttp(),
): Promise<string | null> {
  const data = (await http.request<{ items?: Array<{ id: string }> }>(
    `/auth_configs?toolkitSlug=${encodeURIComponent(toolkitSlug)}`,
  )) as { items?: Array<{ id: string }> };
  return data.items?.[0]?.id ?? null;
}

/** Mint a fresh OAuth connect link. The redirect_url expires in ~12 minutes —
 *  call this at click time, never cache or persist the URL. */
export async function createComposioConnectLink(
  opts: { authConfigId: string; userId: string },
  http: ComposioHttp = createComposioHttp(),
): Promise<ComposioConnectLink> {
  return http.request<ComposioConnectLink>(`/connected_accounts/link`, {
    method: "POST",
    body: { auth_config_id: opts.authConfigId, user_id: opts.userId },
  });
}
