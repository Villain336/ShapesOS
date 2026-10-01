// Marketr — Phase 18 slices 4–5: register a campaign launched in a guided platform's ad manager.
// POST /api/ads/guided/campaign { accountId, name, externalCampaignId, status, budgetCents? } → { ok, campaignId }
//
// Guided-only: Marketr cannot read the campaign from any API, so the user
// registers it manually and reports its state (live/paused/ended). Imported
// spend rows resolve to the row via externalCampaignId. The account's
// platform selects the per-platform registration function.

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { WalmartGuidedError, registerWalmartCampaign } from "@/lib/adplatforms/walmart/guided";
import { SpotifyGuidedError, registerSpotifyCampaign } from "@/lib/adplatforms/spotify/guided";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: {
    accountId?: string;
    name?: string;
    externalCampaignId?: string;
    status?: string;
    budgetCents?: number | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const account = await prisma.adAccount.findFirst({
    where: { id: body.accountId, workspaceId: workspace.id },
    include: { platform: { select: { key: true, displayName: true } } },
  });
  if (!account) return NextResponse.json({ error: "Ad account not found" }, { status: 404 });

  const input = {
    workspaceId: workspace.id,
    accountId: account.id,
    name: body.name ?? "",
    externalCampaignId: body.externalCampaignId ?? "",
    status: body.status ?? "",
    budgetCents: body.budgetCents,
  };

  try {
    const campaign =
      account.platform.key === "walmart"
        ? await registerWalmartCampaign(input)
        : account.platform.key === "spotify"
          ? await registerSpotifyCampaign(input)
          : null;
    if (!campaign) {
      return NextResponse.json(
        { error: `Guided campaign registration is not supported for "${account.platform.displayName}"` },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true, campaignId: campaign.id, requestId: randomUUID() });
  } catch (e) {
    if (e instanceof WalmartGuidedError || e instanceof SpotifyGuidedError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not register the guided campaign" }, { status: 500 });
  }
}
