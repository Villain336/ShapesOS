// Marketr — Wave 2 ChatGPT Ads slice 3: pause route.
// POST /api/ads/chatgpt/campaigns/[id]/pause { reason? } → protective pause
// through the StackAdapt rail. Reversible; not a spend action, so no proposal.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { pauseChatGPTCampaign } from "@/lib/adplatforms/chatgpt/launch";
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
  let body: { reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    const result = await pauseChatGPTCampaign(
      { workspaceId: workspace.id, actor: user.id },
      { chatGPTCampaignId: id, reason: body.reason || `paused by ${user.email ?? "a human"}` },
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ChatGPTAdsError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not pause the campaign." }, { status: 500 });
  }
}
