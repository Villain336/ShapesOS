// Marketr — MCP streamable-HTTP endpoint (Phase C, W5).
//
// POST /mcp — JSON-RPC 2.0 (initialize, tools/list, tools/call).
// Auth: Bearer API key or OAuth token → tenant workspaceId derived server-side
// (lib/mcp/protocol.ts gate chain). GET/DELETE are not part of v1.

import type { NextRequest } from "next/server";
import { handleMcpPost } from "@/lib/mcp/protocol";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }
  const { status, response, retryAfterMs } = await handleMcpPost(req.headers.get("authorization"), body);
  // Notifications get a bare 202.
  if (response === null) return new Response(null, { status: 202 });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (retryAfterMs != null) headers["Retry-After"] = String(Math.ceil(retryAfterMs / 1000));
  return Response.json(response, { status, headers });
}

export async function GET() {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Use POST for MCP requests" } },
    { status: 405 },
  );
}
