// Marketr — Phase 18 slice 2: Amazon Ads OAuth callback.
// GET /api/ads/oauth/callback?code=…&state=… (or ?error=… from Amazon).
//
// Completes the connect_account round-trip: validates the signed state
// (including that it belongs to the logged-in user — CSRF binding),
// exchanges the code, vault-stores the tokens, and links one AdAccount per
// advertising profile. Redirects back to the Advertising hub with
// ?connected=amazon or ?oauth_error=<code>. Tokens never touch URLs, logs,
// or the client.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { AdsOAuthError, parseAdsOAuthState } from "@/lib/adplatforms/oauth";
import { handleAmazonOAuthCallback } from "@/lib/adplatforms/amazon/callback";

const HUB = "/dashboard/media/advertising";

function fail(req: NextRequest, code: string) {
  return NextResponse.redirect(new URL(`${HUB}?oauth_error=${encodeURIComponent(code)}`, req.url));
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const providerError = params.get("error");
  if (providerError) return fail(req, `provider:${providerError}`);
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  if (!code || !state) return fail(req, "missing_params");

  let parsed;
  try {
    parsed = parseAdsOAuthState(state, "amazon-ads");
  } catch (e) {
    return fail(req, e instanceof AdsOAuthError ? e.code : "invalid_state");
  }
  if (parsed.userId !== user.id) return fail(req, "user_mismatch");

  try {
    const base = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
    await handleAmazonOAuthCallback({
      state,
      code,
      redirectUri: `${base}/api/ads/oauth/callback`,
    });
    return NextResponse.redirect(new URL(`${HUB}?connected=amazon`, req.url));
  } catch (e) {
    // Never surface provider internals; the code is enough for the hub to
    // render guidance. Server logs carry the message (tokens excluded by
    // construction — the callback never logs them).
    console.error("[ads/oauth/callback] amazon callback failed:", e instanceof Error ? e.message : e);
    return fail(req, e instanceof AdsOAuthError ? e.code : "callback_failed");
  }
}
