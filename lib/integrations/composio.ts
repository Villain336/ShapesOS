// Marketr — Phase 14: Composio hosted action layer (HTTP boundary).
//
// Composio v3 REST (base https://backend.composio.dev/api/v3, header
// x-api-key). Endpoints used (verified 2026-09-28; toolkits + paging
// re-checked against docs.composio.dev 2026-10-04 — v3 stays supported
// next to v3.1, same list shapes):
//   GET  /toolkits?limit=&cursor=       — toolkit directory (Phase 6 live
//                                          discovery; { items, next_cursor })
//   GET  /tools?toolkit_slug=&search=   — tool catalog ({ items, next_cursor };
//                                          toolkit_versions=latest matches
//                                          execute's version "latest")
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

/** One page of a Composio list endpoint ({ items, next_cursor }). */
export interface ComposioPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ComposioToolItem extends ComposioToolSummary {
  is_deprecated?: boolean;
  tags?: string[];
}

export interface ComposioToolkitSummary {
  slug: string;
  name?: string;
  meta?: {
    description?: string;
    tools_count?: number;
    /** Composio returns objects ({ id, name }); tolerate plain strings. */
    categories?: Array<string | { id?: string; name?: string; slug?: string }>;
  };
  deprecated?: unknown;
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

function pageOf<T>(data: { items?: T[]; next_cursor?: string | null } | null): ComposioPage<T> {
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    nextCursor: typeof data?.next_cursor === "string" && data.next_cursor ? data.next_cursor : null,
  };
}

/** One page of GET /toolkits (Phase 6 live discovery). */
export async function listComposioToolkitsPage(
  opts: { cursor?: string | null; limit?: number },
  http: ComposioHttp = createComposioHttp(),
): Promise<ComposioPage<ComposioToolkitSummary>> {
  const q = new URLSearchParams();
  q.set("limit", String(opts.limit ?? 1000));
  if (opts.cursor) q.set("cursor", opts.cursor);
  return pageOf(
    await http.request<{ items?: ComposioToolkitSummary[]; next_cursor?: string | null }>(`/toolkits?${q}`),
  );
}

/** One page of GET /tools for a toolkit, latest tool versions, no deprecated tools. */
export async function listComposioToolsPage(
  opts: { toolkitSlug: string; cursor?: string | null; limit?: number },
  http: ComposioHttp = createComposioHttp(),
): Promise<ComposioPage<ComposioToolItem>> {
  const q = new URLSearchParams();
  q.set("toolkit_slug", opts.toolkitSlug);
  q.set("toolkit_versions", "latest");
  q.set("limit", String(opts.limit ?? 1000));
  if (opts.cursor) q.set("cursor", opts.cursor);
  return pageOf(
    await http.request<{ items?: ComposioToolItem[]; next_cursor?: string | null }>(`/tools?${q}`),
  );
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
 *  call this at click time, never cache or persist the URL.
 *  redirectUrl (optional): where Composio sends the user after the OAuth
 *  round-trip, with ?connected_account_id= appended. Phase 14 passes our
 *  signed-state callback URL here so the callback can bind the handshake. */
export async function createComposioConnectLink(
  opts: { authConfigId: string; userId: string; redirectUrl?: string },
  http: ComposioHttp = createComposioHttp(),
): Promise<ComposioConnectLink> {
  const body: Record<string, unknown> = {
    auth_config_id: opts.authConfigId,
    user_id: opts.userId,
  };
  if (opts.redirectUrl) body.redirect_url = opts.redirectUrl;
  return http.request<ComposioConnectLink>(`/connected_accounts/link`, {
    method: "POST",
    body,
  });
}
