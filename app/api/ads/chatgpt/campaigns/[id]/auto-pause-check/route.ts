// Marketr — Wave 2 ChatGPT Ads slice 3: auto-pause check route.
// POST /api/ads/chatgpt/campaigns/[id]/auto-pause-check → runs the spend-cap
// rule; pauses only when today's spend exceeds the daily cap by more than
// 10%. Safe to call on a schedule.

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { autoPauseOnSpendBreach } from "@/lib/adplatforms/chatgpt/launch";
import { ChatGPTAdsError } from "@/lib/adplatforms/chatgpt/types";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  try {
    const result = await autoPauseOnSpendBreach(
      { workspaceId: workspace.id, actor: user.id },
      { chatGPTCampaignId: id },
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ChatGPTAdsError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not run the auto-pause check." }, { status: 500 });
  }
}
