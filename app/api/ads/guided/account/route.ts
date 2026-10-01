// Marketr — Phase 18 slice 4: link a Walmart advertiser account (guided).
// POST /api/ads/guided/account { platformKey, name?, externalAccountId } → { ok, accountId }
//
// Walmart Connect has no advertiser OAuth (outcome B — partner-level auth
// only), so linking is manual: the user pastes the advertiser ID from
// Walmart Ad Center. No credential is stored; the row sits in "pending"
// until a WCPN partner credential exists. Fail-closed on any other platform.

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { ensureAdPlatforms } from "@/lib/adplatforms/oauth";
import { WalmartGuidedError, linkWalmartAdvertiserAccount } from "@/lib/adplatforms/walmart/guided";

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

  if (body.platformKey !== "walmart") {
    return NextResponse.json(
      { error: `Guided account linking is not supported for "${body.platformKey ?? "unknown"}" — walmart only` },
      { status: 400 },
    );
  }

  try {
    await ensureAdPlatforms(workspace.id);
    const account = await linkWalmartAdvertiserAccount({
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
    if (e instanceof WalmartGuidedError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not link the Walmart advertiser account" }, { status: 500 });
  }
}
