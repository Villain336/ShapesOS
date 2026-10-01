// Marketr — Wave 2 ChatGPT Ads slice 3: launch route.
// POST /api/ads/chatgpt/campaigns/[id]/launch
// { proposalId, tiersConfirmed, geoConfirmed, dailyCapCents } → launches via
// the Phase 18 spend gate. Fails closed without a fresh (<24h) approval or a
// completed launch checklist.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { launchChatGPTCampaign } from "@/lib/adplatforms/chatgpt/launch";
import { ChatGPTAdsError } from "@/lib/adplatforms/chatgpt/types";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  let body: {
    proposalId?: string;
    tiersConfirmed?: boolean;
    geoConfirmed?: boolean;
    dailyCapCents?: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.proposalId) {
    return NextResponse.json({ error: "proposalId is required" }, { status: 400 });
  }

  try {
    const result = await launchChatGPTCampaign(
      { workspaceId: workspace.id, actor: user.id },
      {
        chatGPTCampaignId: id,
        proposalId: body.proposalId,
        checklist: {
          tiersConfirmed: body.tiersConfirmed === true,
          geoConfirmed: body.geoConfirmed === true,
          dailyCapCents: typeof body.dailyCapCents === "number" ? body.dailyCapCents : -1,
        },
      },
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ChatGPTAdsError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not launch the campaign." }, { status: 500 });
  }
}
