// Marketr — E2E TEST FIXTURE ONLY (Playwright).
// Fake OAuth2 provider "authorize" endpoint. NEVER enabled in production:
// every handler 404s unless E2E_MOCK_OAUTH=1.
//
// GET /api/e2e/mock-oauth/authorize?client_id=&redirect_uri=&state=&...
//   → 302 redirect to {redirect_uri}?code=e2e-mock-code&state={state}
// The redirect_uri is validated to be same-origin as the request to block
// open-redirect abuse even in the E2E environment.

import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const MOCK_CODE = "e2e-mock-code";

export async function GET(req: NextRequest) {
  if (process.env.E2E_MOCK_OAUTH !== "1") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const q = req.nextUrl.searchParams;
  const redirectUri = q.get("redirect_uri") ?? "";
  const state = q.get("state") ?? "";
  if (!redirectUri || !state) {
    return Response.json({ error: "redirect_uri and state are required" }, { status: 400 });
  }
  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    return Response.json({ error: "invalid redirect_uri" }, { status: 400 });
  }
  // Same-origin only — never redirect the E2E browser anywhere else.
  if (target.origin !== req.nextUrl.origin) {
    return Response.json({ error: "redirect_uri must be same-origin" }, { status: 400 });
  }
  target.searchParams.set("code", MOCK_CODE);
  target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}
