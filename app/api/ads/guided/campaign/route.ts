// Marketr — Phase 18 slice 4: register a Walmart campaign launched in Ad Center.
// POST /api/ads/guided/campaign { accountId, name, externalCampaignId, status, budgetCents? } → { ok, campaignId }
//
// Guided-only: Marketr cannot read the campaign from any API, so the user
// registers it manually and reports its state (live/paused/ended). Imported
// spend rows resolve to the row via externalCampaignId.

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { WalmartGuidedError, registerWalmartCampaign } from "@/lib/adplatforms/walmart/guided";

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

  try {
    const campaign = await registerWalmartCampaign({
      workspaceId: workspace.id,
      accountId: body.accountId,
      name: body.name ?? "",
      externalCampaignId: body.externalCampaignId ?? "",
      status: body.status ?? "",
      budgetCents: body.budgetCents,
    });
    return NextResponse.json({ ok: true, campaignId: campaign.id, requestId: randomUUID() });
  } catch (e) {
    if (e instanceof WalmartGuidedError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not register the Walmart campaign" }, { status: 500 });
  }
}
