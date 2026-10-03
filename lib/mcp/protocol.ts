// Marketr — MCP streamable-HTTP protocol handler (Phase C, W5).
//
// Hand-rolled JSON-RPC 2.0 for initialize / notifications/initialized /
// tools/list / tools/call over POST /mcp (see THREAT-MODEL-MCP.md T11 for why
// the SDK's Node-transport isn't used in App Router).
//
// Gate chain per request (order matters):
//   1. Bearer auth → tenant ctx (generic 401, reasons stay server-side)
//   2. Workspace mcpEnabled (fresh read every request — T8)
//   3. Per-credential rate limit (T4)
//   4. JSON-RPC shape validation (single call only, no batches)
//   5. Method dispatch; tools/call additionally: scope check → meter → run → audit

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { hasScope, requireMcpAuth, type McpAuthContext } from "./auth";
import { checkMcpRateLimit } from "./rateLimit";
import { meterToolCall } from "./metering";
import { mcpAudit } from "./audit";
import { getTool, listTools, toolInputJsonSchema, ToolError, type ToolDef } from "./tools";
import { scopeForTool, MCP_TOOL_NAMES, type McpToolName } from "./scopes";
import { featureUpgradeMessage, planHasFeature } from "@/lib/billing/entitlements";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "marketr", version: "0.1.0" };

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function err(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function parseRequest(body: unknown): { ok: true; req: JsonRpcRequest } | { ok: false; response: JsonRpcResponse } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, response: err(null, -32600, "Invalid Request: batch requests are not supported") };
  }
  const b = body as Record<string, unknown>;
  if (b.jsonrpc !== "2.0" || typeof b.method !== "string") {
    return { ok: false, response: err(typeof b.id === "string" || typeof b.id === "number" ? b.id : null, -32600, "Invalid Request") };
  }
  const id = b.id === undefined ? null : b.id;
  if (id !== null && typeof id !== "string" && typeof id !== "number") {
    return { ok: false, response: err(null, -32600, "Invalid Request: id must be string, number, or null") };
  }
  return {
    ok: true,
    req: { jsonrpc: "2.0", id, method: b.method, params: (b.params ?? {}) as Record<string, unknown> },
  };
}

async function workspaceMcpState(workspaceId: string): Promise<{ enabled: boolean; entitled: boolean }> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { mcpEnabled: true, plan: true } });
  // Phase 4a: API/MCP access is a plan entitlement, checked on every call so
  // a downgrade closes the surface immediately.
  return { enabled: ws?.mcpEnabled === true, entitled: planHasFeature(ws?.plan, "api_access") };
}

function credentialId(ctx: McpAuthContext): string {
  return ctx.credential.kind === "api_key" ? ctx.credential.keyId : `oauth:${ctx.credential.clientId}`;
}

/**
 * Handle one POST /mcp JSON-RPC call.
 * Returns { status, response } — response is null for notifications (202).
 */
export async function handleMcpPost(
  authorizationHeader: string | null,
  body: unknown,
): Promise<{ status: number; response: JsonRpcResponse | null; retryAfterMs?: number }> {
  // 1. Auth.
  const auth = await requireMcpAuth(authorizationHeader);
  if (!auth.ok) {
    // Generic to the client; the reason stays in server logs (T3).
    console.warn(`[mcp] auth failed: ${auth.reason}`);
    return { status: 401, response: err(null, -32000, "Authentication failed") };
  }
  const ctx = auth.ctx;

  // 2. Workspace opt-in gate (T8) — before any protocol work.
  const mcpState = await workspaceMcpState(ctx.workspaceId);
  if (!mcpState.enabled) {
    await mcpAudit({ projectId: null, workspaceId: ctx.workspaceId, action: "mcp_tool_denied", ctx, outcome: "denied: mcp_disabled" });
    return { status: 403, response: err(null, -32000, "MCP is not enabled for this workspace") };
  }
  // 2b. Plan entitlement (Phase 4a).
  if (!mcpState.entitled) {
    await mcpAudit({ projectId: null, workspaceId: ctx.workspaceId, action: "mcp_tool_denied", ctx, outcome: "denied: plan_no_api_access" });
    return { status: 403, response: err(null, -32000, featureUpgradeMessage("api_access")) };
  }

  // 3. Per-credential rate limit (T4).
  const rl = await checkMcpRateLimit(credentialId(ctx));
  if (!rl.allowed) {
    await mcpAudit({ projectId: null, workspaceId: ctx.workspaceId, action: "mcp_tool_denied", ctx, outcome: "denied: rate_limited" });
    return { status: 429, response: err(null, -32000, "Rate limit exceeded"), retryAfterMs: rl.retryAfterMs };
  }

  // 4. Shape.
  const parsed = parseRequest(body);
  if (!parsed.ok) return { status: 400, response: parsed.response };
  const req = parsed.req;

  // 5. Dispatch.
  switch (req.method) {
    case "initialize": {
      const params = req.params ?? {};
      const clientVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
      const negotiated = clientVersion && PROTOCOL_VERSIONS.includes(clientVersion) ? clientVersion : PROTOCOL_VERSIONS[0];
      // Every authenticated RPC is audit-logged (T10) — sessions are forensic evidence.
      await mcpAudit({ projectId: null, workspaceId: ctx.workspaceId, action: "mcp_rpc", tool: "initialize", ctx, outcome: `rpc:initialize protocol=${negotiated}` });
      return {
        status: 200,
        response: ok(req.id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }),
      };
    }
    case "notifications/initialized":
      return { status: 202, response: null };
    case "tools/list": {
      // Least privilege: only tools the caller is scoped for (T2 hygiene).
      const visible = listTools().filter((t) => hasScope(ctx, t.name));
      await mcpAudit({ projectId: null, workspaceId: ctx.workspaceId, action: "mcp_rpc", tool: "tools/list", ctx, outcome: `rpc:tools/list visible=${visible.length}` });
      return {
        status: 200,
        response: ok(req.id, {
          tools: visible.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: toolInputJsonSchema(t),
          })),
        }),
      };
    }
    case "tools/call": {
      return await handleToolCall(ctx, req);
    }
    default:
      return { status: 200, response: err(req.id, -32601, `Method not found: ${req.method}`) };
  }
}

async function handleToolCall(
  ctx: McpAuthContext,
  req: JsonRpcRequest,
): Promise<{ status: number; response: JsonRpcResponse }> {
  const params = req.params ?? {};
  const toolName = typeof params.name === "string" ? params.name : "";
  const tool = getTool(toolName);

  const deny = async (outcome: string, code: number, message: string) => {
    await mcpAudit({ projectId: null, workspaceId: ctx.workspaceId, action: "mcp_tool_denied", tool: toolName || "(unknown)", ctx, outcome });
    return { status: 200 as const, response: err(req.id, code, message) };
  };

  if (!tool || !(MCP_TOOL_NAMES as readonly string[]).includes(toolName)) {
    return deny("denied: unknown_tool", -32602, `Unknown tool: ${toolName}`);
  }
  // Scope check BEFORE metering or execution (T2).
  if (!hasScope(ctx, toolName)) {
    return deny(`denied: missing scope ${scopeForTool(toolName)}`, -32000, "Insufficient scope for this tool");
  }
  // Args validation (strict — T1: unknown keys like workspaceId are rejected).
  const parsedArgs = tool.inputSchema.safeParse(params.arguments ?? {});
  if (!parsedArgs.success) {
    return deny("denied: invalid_arguments", -32602, "Invalid tool arguments");
  }

  // Meter BEFORE execution; fail closed on any metering problem (T9).
  // keyId attributes usage to the calling API key (G3; undefined for OAuth).
  const callId = randomUUID();
  const metered = await meterToolCall({
    workspaceId: ctx.workspaceId,
    tool: toolName as McpToolName,
    actorId: ctx.userId,
    callId,
    keyId: ctx.credential.kind === "api_key" ? ctx.credential.keyId : undefined,
  });
  if (!metered.ok) {
    const message =
      metered.reason === "cap_exceeded"
        ? "Spend cap exceeded — the call was not executed"
        : "Metering is temporarily unavailable — the call was not executed";
    return deny(`denied: metering_${metered.reason}`, -32000, message);
  }

  try {
    const result = await tool.handler(ctx, parsedArgs.data as Record<string, unknown>);
    await mcpAudit({
      projectId: null,
      workspaceId: ctx.workspaceId,
      action: "mcp_tool_called",
      tool: toolName,
      ctx,
      outcome: `executed call=${callId}`,
      charged: metered.charged,
    });
    return {
      status: 200,
      response: ok(req.id, { content: [{ type: "text", text: JSON.stringify(result.data) }], isError: false }),
    };
  } catch (e) {
    const toolErr = e instanceof ToolError ? e : null;
    await mcpAudit({
      projectId: null,
      workspaceId: ctx.workspaceId,
      action: "mcp_tool_denied",
      tool: toolName,
      ctx,
      outcome: `error: ${toolErr?.code ?? "handler_error"}`,
      charged: metered.charged,
    });
    // Generic handler errors to the client; the meter charge stands (the call
    // was metered before execution — documented in the audit row).
    return {
      status: 200,
      response: ok(req.id, {
        content: [{ type: "text", text: JSON.stringify({ error: toolErr?.code ?? "tool_error" }) }],
        isError: true,
      }),
    };
  }
}
