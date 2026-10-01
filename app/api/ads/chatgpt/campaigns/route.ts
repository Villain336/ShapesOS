// Marketr — Wave 2 ChatGPT Ads slice 2: campaign propose API.
// POST /api/ads/chatgpt/campaigns — propose a ChatGPT campaign (creates the
// draft + creative variants and emits a launch SpendProposal; never spends).
// GET /api/ads/chatgpt/campaigns — list the workspace's ChatGPT campaigns.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { proposeChatGPTCampaign } from "@/lib/adplatforms/chatgpt/propose";
import { ChatGPTAdsError } from "@/lib/adplatforms/chatgpt/types";
import { adsManagerDeepLink } from "@/lib/adplatforms/chatgpt/types";

interface ProposeBody {
  accountId?: string;
  name?: string;
  objective?: string;
  targetTiers?: string[];
  topicIntentTags?: string[] | string;
  budgetDailyCents?: number | null;
  budgetTotalCents?: number | null;
  bidStrategy?: string;
  creatives?: Array<{
    headline?: string;
    body?: string;
    ctaLabel?: string;
    locale?: string;
    source?: string;
    aiProviderUsed?: string;
    aiModelUsed?: string;
  }>;
}

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const campaigns = await prisma.chatGPTCampaign.findMany({
    where: { workspaceId: workspace.id },
    include: {
      campaign: { select: { name: true, externalId: true } },
      creatives: { select: { id: true, headline: true, approvalStatus: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ campaigns });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: ProposeBody;
  try {
    body = (await req.json()) as ProposeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const tiers = (body.targetTiers ?? []).filter((t) => t === "free" || t === "go") as (
    | "free"
    | "go"
  )[];
  const tags = Array.isArray(body.topicIntentTags)
    ? body.topicIntentTags
    : typeof body.topicIntentTags === "string"
      ? body.topicIntentTags.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

  try {
    const result = await proposeChatGPTCampaign(
      { workspaceId: workspace.id, actor: user.id },
      {
        accountId: body.accountId ?? "",
        name: body.name ?? "",
        objective: body.objective,
        targetTiers: tiers,
        topicIntentTags: tags,
        budgetDailyCents: body.budgetDailyCents ?? null,
        budgetTotalCents: body.budgetTotalCents ?? null,
        bidStrategy: body.bidStrategy === "cpm" ? "cpm" : "cpc",
        creatives: (body.creatives ?? []).map((c) => ({
          headline: c.headline ?? "",
          body: c.body ?? "",
          ctaLabel: c.ctaLabel,
          locale: c.locale || "en-US",
          source: c.source === "ai_generated" ? "ai_generated" : "human",
          aiProviderUsed: c.aiProviderUsed,
          aiModelUsed: c.aiModelUsed,
        })),
      },
    );
    return NextResponse.json({
      ok: true,
      campaignId: result.chatGPTCampaign.id,
      proposalId: result.proposal.id,
      adsManagerLink: adsManagerDeepLink({ campaignName: body.name ?? "" }),
    });
  } catch (err) {
    if (err instanceof ChatGPTAdsError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not propose the campaign." }, { status: 500 });
  }
}
