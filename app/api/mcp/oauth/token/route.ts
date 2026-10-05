// Marketr — OAuth 2.1 token endpoint (Phase C, W5).
//
// POST /api/mcp/oauth/token { grant_type: "authorization_code", code,
//   redirect_uri, client_id, code_verifier? }
//
// PUBLIC BY DESIGN (capability model): the single-use authorization code +
// PKCE verifier IS the credential (standard OAuth). Strict pre-auth rate
// limit; codes are single-use, 10-minute, and bound to client_id +
// redirect_uri (T6).

import type { NextRequest } from "next/server";
import { exchangeCode } from "@/lib/mcp/oauth";
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
  const b = body as Record<string, unknown>;
  if (b.grant_type !== "authorization_code") {
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
  if (typeof b.code !== "string" || typeof b.client_id !== "string" || typeof b.redirect_uri !== "string") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const res = await exchangeCode({
    code: b.code,
    clientId: b.client_id,
    redirectUri: b.redirect_uri,
    codeVerifier: typeof b.code_verifier === "string" ? b.code_verifier : undefined,
  });
  if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
  return Response.json(res.token);
}
