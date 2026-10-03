// Marketr — M21 generic MCP client (spec §7 flow 5, §11).
//
// Wraps the @modelcontextprotocol/sdk Client over StreamableHTTPClientTransport
// so a workspace-custom MCP server (a `Connector` DB row, kind=mcp) is
// indistinguishable from a native adapter behind the ConnectorAdapter
// interface. No application logic lives here — just transport, schema
// conversion, and the self-hosted-only stdio gate.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ConnectorToolDef } from "./types";

/**
 * Spec decision (§13): stdio MCP servers are allowed ONLY on self-hosted
 * deployments — stdio needs local process execution, unsafe on hosted.
 */
export function isStdioAllowed(): boolean {
  return process.env.MARKETR_SELF_HOSTED === "true";
}

export interface McpServerInfo {
  serverName: string;
  tools: ConnectorToolDef[];
}

interface RawTool {
  name: string;
  description?: string | null;
  /** MCP tool annotations (spec 2025-03-26+); only readOnlyHint is used. */
  annotations?: { readOnlyHint?: unknown } | null;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  } | null;
}

/**
 * Convert an MCP tool schema to a ConnectorToolDef.
 *
 * H5: a custom MCP server's tools are MUTATING BY DEFAULT, so the chat
 * confirmation gate stops them (prompt-injected text from a file, connector
 * read or recalled memory can't make the agent call send_/delete_/create_
 * tools without a human "yes"). A tool counts as read-only only when the
 * server annotates it `readOnlyHint: true` or a workspace admin allow-lists
 * it (Connector.config.readOnlyTools).
 */
export function mcpToolToDef(
  raw: RawTool,
  opts: { readOnlyTools?: Iterable<string> } = {},
): ConnectorToolDef {
  const allowListed = new Set(opts.readOnlyTools ?? []);
  const readOnly = raw.annotations?.readOnlyHint === true || allowListed.has(raw.name);
  const props: Record<string, { type: string; description: string }> = {};
  for (const [k, v] of Object.entries(raw.inputSchema?.properties ?? {})) {
    props[k] = {
      type: typeof v?.type === "string" ? v.type : "string",
      description: v?.description ?? "",
    };
  }
  return {
    name: raw.name,
    description: raw.description ?? raw.name,
    mutating: !readOnly,
    argsSchema: {
      type: "object",
      properties: props,
      ...(raw.inputSchema?.required?.length ? { required: raw.inputSchema.required } : {}),
    },
  };
}

export class McpConnectorClient {
  private client: Client | null = null;
  private endpoint: string | null = null;
  private closed = false;

  /**
   * Connect to an MCP server.
   * - endpoint: Streamable-HTTP URL (all deployments), or
   * - stdio command (`stdio:<command> <args...>`) — self-hosted ONLY.
   */
  async connect(
    endpoint: string,
    opts: { readOnlyTools?: Iterable<string> } = {},
  ): Promise<McpServerInfo> {
    if (this.client) throw new Error("McpConnectorClient already connected");
    this.endpoint = endpoint;
    const client = new Client({ name: "marketr-mcp", version: "1.0.0" });

    if (endpoint.startsWith("stdio:")) {
      if (!isStdioAllowed()) {
        throw new Error(
          "Stdio MCP transports are only allowed on self-hosted deployments (MARKETR_SELF_HOSTED=true).",
        );
      }
      const [command, ...args] = endpoint.slice("stdio:".length).trim().split(/\s+/);
      const transport = new StdioClientTransport({ command, args });
      await client.connect(transport);
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(endpoint));
      await client.connect(transport);
    }

    const { tools } = await client.listTools();
    this.client = client;
    return {
      serverName: endpoint,
      tools: (tools as RawTool[]).map((t) => mcpToolToDef(t, opts)),
    };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error("McpConnectorClient not connected");
    const result = await this.client.callTool({ name, arguments: args });
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client) {
      await this.client.close().catch(() => undefined);
      this.client = null;
    }
  }
}
