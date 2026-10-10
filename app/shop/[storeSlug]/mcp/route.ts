// ShapesOS — Phase 21A (WS=agentweb): POST /shop/[storeSlug]/mcp — a minimal MCP server
// (JSON-RPC 2.0, tools only) over this store's PUBLISHED catalogue. One tool, `ask`,
// annotated read-only. initialize / tools/list / tools/call / prompts/list / ping.
//
// PUBLIC BY DESIGN, READ-ONLY, UNAUTHENTICATED: same model as ../ask. The only mutating
// verb is POST and what it does is answer a question; it cannot buy, order, email or
// change anything, there is no other tool to call, and an unknown tool is an error. Only
// a PUBLISHED store resolves; per-store+IP window; 8 KiB body cap; no batches.

import { NextResponse } from "next/server";
import { handleMcp } from "@/lib/agentweb/site/nlweb";
import { CORS, MCP_BODY_LIMIT, json, preflight, storefrontContext } from "@/lib/agentweb/site/storefront-http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ storeSlug: string }> };

const rpcError = (code: number, message: string, status = 400) => json({ jsonrpc: "2.0", id: null, error: { code, message } }, status);

export async function POST(req: Request, { params }: Params) {
  const { storeSlug } = await params;
  const ctx = await storefrontContext(req, storeSlug, "mcp");
  if (ctx instanceof Response) return ctx;
  const raw = await req.text();
  if (raw.length > MCP_BODY_LIMIT) return rpcError(-32600, "Request too large", 413);
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return rpcError(-32700, "Parse error");
  }
  if (Array.isArray(message)) return rpcError(-32600, "Batches are not supported");
  const reply = handleMcp(ctx.docs, { name: ctx.store.name, origin: ctx.urls.origin }, message);
  // A notification gets no JSON-RPC reply: 202 Accepted with an empty body (MCP streamable HTTP).
  return reply ? json(reply) : new NextResponse(null, { status: 202, headers: CORS });
}

export function GET() {
  return json({ error: "This is an MCP endpoint: POST JSON-RPC 2.0 messages to it." }, 405, { Allow: "POST, OPTIONS" });
}

export function OPTIONS() {
  return preflight();
}
