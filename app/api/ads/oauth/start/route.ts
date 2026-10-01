// Marketr — Phase 18 slice 1: start the OAuth consent flow for an ad platform.
// GET /api/ads/oauth/start?platform=amazon → { url } (302-style JSON; the
// client navigates). The token exchange callback lands with each platform
// connector slice — this route only builds the consent URL.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { startAdsOAuth, AdsOAuthError } from "@/lib/adplatforms/oauth";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const platform = req.nextUrl.searchParams.get("platform") ?? "";
  try {
    const base = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
    const { url } = startAdsOAuth(platform, user.id, workspace.id, base);
    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof AdsOAuthError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not start OAuth" }, { status: 500 });
  }
}
