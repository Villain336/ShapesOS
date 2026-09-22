// Marketr — E2E TEST FIXTURE ONLY (Playwright).
// Fake OAuth2 provider "token" endpoint. NEVER enabled in production:
// every handler 404s unless E2E_MOCK_OAUTH=1.
//
// POST /api/e2e/mock-oauth/token (grant_type=authorization_code, code=e2e-mock-code)
//   → { access_token, refresh_token, expires_in, token_type, scope }
// Any other code is rejected, mirroring a real provider's invalid_grant.

import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (process.env.E2E_MOCK_OAUTH !== "1") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const body = await req.text();
  const params = new URLSearchParams(body);
  if (params.get("grant_type") !== "authorization_code" || params.get("code") !== "e2e-mock-code") {
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }
  return Response.json({
    access_token: "e2e-mock-access-token",
    refresh_token: "e2e-mock-refresh-token",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "e2e:read",
  });
}
