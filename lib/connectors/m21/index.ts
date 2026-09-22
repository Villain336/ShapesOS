// Marketr — M21 connector resolution (spec §7, §11).
//
// getAdapterForConnection() is the single entry point the agent loop and
// routes use: a built-in key resolves to its native adapter; anything else
// resolves to a workspace-custom MCP server (Connector DB row, kind=mcp)
// wrapped as a ConnectorAdapter. Unknown keys fail closed.

import type { ConnectorAdapter, ConnectorToolDef, DecryptedCredential, InvokeContext, InvokeResult } from "./types";
import { isBuiltinKey, resolveAdapter } from "./registry";
import { McpConnectorClient } from "./mcp";

export interface ConnectionRef {
  /** Built-in native key (e.g. "wordpress") or a custom Connector.key. */
  connectorKey: string;
  connector?: { mcpEndpoint: string | null } | null;
}

interface CachedTools {
  expiresAt: number;
  tools: ConnectorToolDef[];
}

/** Per-process cache of MCP tool lists: endpoint → { tools, expiresAt }. 5-min TTL. */
const mcpToolsCache = new Map<string, CachedTools>();
const MCP_TOOLS_TTL_MS = 5 * 60 * 1000;

async function listMcpToolsCached(endpoint: string): Promise<ConnectorToolDef[]> {
  const cached = mcpToolsCache.get(endpoint);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;
  const client = new McpConnectorClient();
  try {
    const info = await client.connect(endpoint);
    mcpToolsCache.set(endpoint, { expiresAt: Date.now() + MCP_TOOLS_TTL_MS, tools: info.tools });
    return info.tools;
  } finally {
    await client.close();
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
  ) {
    this.key = connectorKey;
    this.displayName = displayName;
  }

  listTools(): ConnectorToolDef[] {
    throw new Error(
      `McpBackedAdapter for "${this.key}" needs an async tool list — use listToolsAsync() instead.`,
    );
  }

  /** Async tool listing (cached per process, 5-min TTL). */
  async listToolsAsync(): Promise<ConnectorToolDef[]> {
    return listMcpToolsCached(this.endpoint);
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    _credential: DecryptedCredential | null,
    _ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const client = new McpConnectorClient();
    try {
      await client.connect(this.endpoint);
      const result = await client.callTool(tool, args);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await client.close();
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
  return new McpBackedAdapter(conn.connectorKey, conn.connectorKey, endpoint);
}
