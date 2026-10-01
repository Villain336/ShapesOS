// Marketr — Phase 18 slices 4–5: link a guided-platform advertiser account.
// POST /api/ads/guided/account { platformKey, name?, externalAccountId } → { ok, accountId }
//
// Walmart Connect (slice 4, outcome B) and Spotify (slice 5) are guided-only —
// no advertiser OAuth exists — so linking is manual: the user pastes the
// advertiser/ad account ID from the platform's ad manager. No credential is
// stored; the row sits in "pending". Fail-closed on any other platform.

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { ensureAdPlatforms } from "@/lib/adplatforms/oauth";
import { WalmartGuidedError, linkWalmartAdvertiserAccount } from "@/lib/adplatforms/walmart/guided";
import { SpotifyGuidedError, linkSpotifyAdAccount } from "@/lib/adplatforms/spotify/guided";

const GUIDED_LINKABLE = ["walmart", "spotify"] as const;
type GuidedLinkable = (typeof GUIDED_LINKABLE)[number];

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { platformKey?: string; name?: string; externalAccountId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const platformKey = body.platformKey as GuidedLinkable | undefined;
  if (!platformKey || !GUIDED_LINKABLE.includes(platformKey)) {
    return NextResponse.json(
      { error: `Guided account linking is not supported for "${body.platformKey ?? "unknown"}" — walmart or spotify only` },
      { status: 400 },
    );
  }

  try {
    await ensureAdPlatforms(workspace.id);
    const account =
      platformKey === "walmart"
        ? await linkWalmartAdvertiserAccount({
            workspaceId: workspace.id,
            name: body.name,
            externalAccountId: body.externalAccountId ?? "",
          })
        : await linkSpotifyAdAccount({
            workspaceId: workspace.id,
            name: body.name,
            externalAccountId: body.externalAccountId ?? "",
          });
    return NextResponse.json({
      ok: true,
      accountId: account.id,
      externalAccountId: account.externalAccountId,
      requestId: randomUUID(),
    });
  } catch (e) {
    if (e instanceof WalmartGuidedError || e instanceof SpotifyGuidedError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not link the guided advertiser account" }, { status: 500 });
  }
}
