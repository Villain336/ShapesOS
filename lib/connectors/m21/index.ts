// Marketr — M21 connector resolution (spec §7, §11).
//
// getAdapterForConnection() is the single entry point the agent loop and
// routes use: a built-in key resolves to its native adapter; anything else
// resolves to a workspace-custom MCP server (Connector DB row, kind=mcp)
// wrapped as a ConnectorAdapter. Unknown keys fail closed.

import type { ConnectorAdapter, ConnectorToolDef, DecryptedCredential, InvokeContext, InvokeResult } from "./types";
import { isBuiltinKey, resolveAdapter } from "./registry";
import { McpConnectorClient, type McpServerInfo } from "./mcp";
import { mcpOAuthConfig } from "./mcp-oauth";

export interface ConnectionRef {
  /** Built-in native key (e.g. "wordpress") or a custom Connector.key. */
  connectorKey: string;
  /** `config` carries the admin read-only allow-list (`readOnlyTools`). */
  connector?: { mcpEndpoint: string | null; config?: unknown } | null;
  /** Phase 11 (conncore): the connection whose vault token an OAuth MCP server needs. */
  connectionId?: string | null;
}

/**
 * Admin allow-list of MCP tool names treated as read-only (H5), stored at
 * Connector.config.readOnlyTools. Anything malformed → empty (fail closed:
 * every tool stays mutating).
 */
export function readOnlyToolsFromConfig(config: unknown): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const list = (config as Record<string, unknown>).readOnlyTools;
  if (!Array.isArray(list)) return [];
  return list.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 200);
}

interface CachedTools {
  expiresAt: number;
  tools: ConnectorToolDef[];
}

/** Per-process cache of MCP tool lists: endpoint → { tools, expiresAt }. 5-min TTL. */
const mcpToolsCache = new Map<string, CachedTools>();
const MCP_TOOLS_TTL_MS = 5 * 60 * 1000;

async function listMcpToolsCached(endpoint: string, auth: McpAuthSource | null = null): Promise<ConnectorToolDef[]> {
  // Phase 11 (conncore): OAuth servers cache per connection (tool lists can differ per grant).
  const cacheKey = auth ? `${endpoint}#${auth.connectionId}` : endpoint;
  const cached = mcpToolsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;
  const info = await withMcpClient(endpoint, auth, (client) => Promise.resolve(client.info));
  mcpToolsCache.set(cacheKey, { expiresAt: Date.now() + MCP_TOOLS_TTL_MS, tools: info.tools });
  return info.tools;
}

/**
 * Phase 11 (conncore): where an OAuth-protected MCP server's token comes from.
 * `credential` is the decrypted vault credential (or a loader for it);
 * `refresh` refreshes once after a 401.
 */
export interface McpAuthSource {
  connectionId: string;
  token: () => Promise<string | null>;
  refresh?: () => Promise<string | null>;
}

/** Vault-backed token source for an MCP connection (lazy; refresh once). */
export function vaultMcpAuth(connectionId: string): McpAuthSource {
  let loaded: Promise<{ token: string | null; refresh: () => Promise<string | null> }> | null = null;
  const load = () => {
    loaded ??= (async () => {
      const { loadLiveCredential } = await import("./live/credentials");
      const { credential, refreshCredential } = await loadLiveCredential(connectionId);
      const tok = (c: unknown) => {
        const t = (c as { payload?: { access_token?: unknown } } | null)?.payload?.access_token;
        return typeof t === "string" && t ? t : null;
      };
      return { token: tok(credential), refresh: async () => tok(await refreshCredential()) };
    })();
    return loaded;
  };
  return { connectionId, token: async () => (await load()).token, refresh: async () => (await load()).refresh() };
}

/** Connect (with the bearer token when OAuth), run fn, close; one refresh+retry on 401. */
async function withMcpClient<T>(
  endpoint: string,
  auth: McpAuthSource | null,
  fn: (client: { info: McpServerInfo; client: McpConnectorClient }) => Promise<T>,
): Promise<T> {
  const { isUnauthorized } = await import("./mcp-oauth");
  const attempt = async (token: string | null) => {
    const client = new McpConnectorClient();
    try {
      const info = await client.connect(endpoint, { accessToken: token });
      return await fn({ info, client });
    } finally {
      await client.close();
    }
  };
  if (!auth) return attempt(null);
  const token = await auth.token();
  if (!token) throw new Error("This MCP server needs you to sign in — connect it on Settings → Connectors.");
  try {
    return await attempt(token);
  } catch (err) {
    if (!isUnauthorized(err) || !auth.refresh) throw err;
    const fresh = await auth.refresh();
    if (!fresh) throw new Error("The MCP server rejected the stored sign-in and it could not be refreshed — reconnect it on Settings → Connectors.");
    return attempt(fresh);
  }
}

/** Wraps a workspace-custom MCP server as a ConnectorAdapter. */
export class McpBackedAdapter implements ConnectorAdapter {
  readonly key: string;
  readonly displayName: string;
  readonly authType = "none" as const;
  readonly configSchema = { type: "object", properties: {} };

  constructor(
    connectorKey: string,
    displayName: string,
    private endpoint: string,
    private readOnlyTools: readonly string[] = [],
    /** Phase 11 (conncore): set for OAuth-protected servers. */
    private auth: McpAuthSource | null = null,
  ) {
    this.key = connectorKey;
    this.displayName = displayName;
  }

  listTools(): ConnectorToolDef[] {
    throw new Error(
      `McpBackedAdapter for "${this.key}" needs an async tool list — use listToolsAsync() instead.`,
    );
  }

  /**
   * Async tool listing (cached per process, 5-min TTL). Cached defs carry
   * only the server's own readOnlyHint; this connector's admin allow-list is
   * applied on top (never cached across connectors sharing an endpoint).
   */
  async listToolsAsync(): Promise<ConnectorToolDef[]> {
    const tools = await listMcpToolsCached(this.endpoint, this.auth);
    if (this.readOnlyTools.length === 0) return tools;
    const allow = new Set(this.readOnlyTools);
    return tools.map((t) => (allow.has(t.name) ? { ...t, mutating: false } : t));
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    // Phase 11 (conncore): OAuth servers use the credential the gate loaded
    // (refresh once through the vault on 401).
    let auth: McpAuthSource | null = null;
    if (this.auth) {
      const t = credential?.payload?.access_token;
      auth = {
        connectionId: this.auth.connectionId,
        token: async () => (typeof t === "string" && t ? t : this.auth!.token()),
        refresh: ctx.refreshCredential
          ? async () => {
              const next = await ctx.refreshCredential!();
              const nt = next?.payload?.access_token;
              return typeof nt === "string" && nt ? nt : null;
            }
          : this.auth.refresh,
      };
    }
    try {
      const result = await withMcpClient(this.endpoint, auth, ({ client }) => client.callTool(tool, args));
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Resolve the adapter for a connection:
 * - built-in key → native adapter (code-defined, never a DB row);
 * - custom key → McpBackedAdapter over the connector's mcpEndpoint.
 * Throws on unknown keys and on custom keys without a usable MCP endpoint.
 */
export async function getAdapterForConnection(conn: ConnectionRef): Promise<ConnectorAdapter> {
  if (isBuiltinKey(conn.connectorKey)) {
    return resolveAdapter(conn.connectorKey);
  }
  const endpoint = conn.connector?.mcpEndpoint ?? null;
  if (!endpoint) {
    throw new Error(
      `Connector "${conn.connectorKey}" is not a built-in key and has no mcpEndpoint configured.`,
    );
  }
  // Phase 11 (conncore): an OAuth-protected server carries its connection's vault token.
  const needsAuth = mcpOAuthConfig(conn.connector?.config) !== null;
  if (needsAuth && !conn.connectionId) {
    throw new Error(`MCP server "${conn.connectorKey}" needs a signed-in connection — connect it on Settings → Connectors.`);
  }
  return new McpBackedAdapter(
    conn.connectorKey,
    conn.connectorKey,
    endpoint,
    readOnlyToolsFromConfig(conn.connector?.config),
    needsAuth && conn.connectionId ? vaultMcpAuth(conn.connectionId) : null,
  );
}
