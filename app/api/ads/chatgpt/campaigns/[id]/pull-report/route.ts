// Marketr — Wave 2 ChatGPT Ads slice 4: pull-report route.
// POST /api/ads/chatgpt/campaigns/[id]/pull-report { startDate?, endDate? }
// Pulls StackAdapt delivery into AdReport rows, returns the summary and the
// CPA variance check. Reads only from the platform; the variance alert is
// the only side effect besides the ingested rows.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { pullChatGPTReport } from "@/lib/adplatforms/chatgpt/reporting";
import { ChatGPTAdsError } from "@/lib/adplatforms/chatgpt/types";

function defaultRange(): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 13);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

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
  let body: { startDate?: string; endDate?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const range = defaultRange();

  try {
    const result = await pullChatGPTReport(
      { workspaceId: workspace.id, actor: user.id },
      {
        chatGPTCampaignId: id,
        startDate: body.startDate ?? range.startDate,
        endDate: body.endDate ?? range.endDate,
      },
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ChatGPTAdsError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not pull the report." }, { status: 500 });
  }
}
