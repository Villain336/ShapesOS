// Marketr — OAuth 2.1 Dynamic Client Registration (RFC 7591), Phase C W5.
//
// POST /api/mcp/oauth/register { redirect_uris[], client_name?, scope? }
//
// PUBLIC BY DESIGN: open registration is the point of DCR (no pre-shared
// client id). No credentials are issued here — only a client_id. Strict
// pre-auth rate limit (10/min/IP) + full redirect_uri validation apply.
// The client becomes usable only after the signed-in user approves it on the
// consent screen, which binds the token to the user's workspace.

import type { NextRequest } from "next/server";
import { registerClient } from "@/lib/mcp/oauth";
import { checkPreAuthRateLimit } from "@/lib/mcp/rateLimit";
import { clientIpFromHeaders } from "@/lib/api/client-ip";

export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string {
  return clientIpFromHeaders(req.headers) ?? "unknown";
}

export async function POST(req: NextRequest) {
  const rl = await checkPreAuthRateLimit(clientIp(req));
  if (!rl.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  // DCR is PUBLIC by design (RFC 7591): no session required. Registration
  // creates an opaque client_id and binds nothing — no workspace, no token,
  // no secret. The client becomes usable only after the signed-in user
  // approves it on the consent screen, which claims ownership and binds the
  // token to the approver's workspace.
  const b = body as Record<string, unknown>;
  const res = await registerClient(
    {
      redirect_uris: Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [],
      client_name: typeof b.client_name === "string" ? b.client_name : undefined,
      scope: typeof b.scope === "string" ? b.scope : undefined,
    },
    null,
  );
  if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
  return Response.json(
    {
      client_id: res.client.client_id,
      client_name: res.client.client_name,
      redirect_uris: res.client.redirect_uris,
      scope: res.client.scope,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    { status: 201 },
  );
}
