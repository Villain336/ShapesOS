// ShapesOS — social posts in Attribution (Phase 4b).
//
// Engagement is channel data, not a lead touch: impressions, likes,
// comments, shares and clicks per post come from social_post_metrics. The
// revenue side comes from ordinary touches: every link a post carries is
// UTM-tagged (utm_medium=social → channel social_organic, utm_campaign = the
// post's campaign, utm_content = the post id), so a lead captured from a
// social link gets a social_organic touch whose meta.utm_content names the
// post. This module joins the two:
//   touch.meta.utm_content = post id  → that post
//   else touch.campaign = a post's campaign slug → shared across that
//        campaign's posts (credit split evenly)
// Revenue credit per touch uses the same models as the rest of the report.

import { prisma } from "@/lib/prisma";
import { getReportData, type ReportWindow } from "./report";
import { creditByModel, type AttributionModel, type ModelTouch } from "./models";
import { getSocialEngagement, type EngagementNumbers, type SocialEngagement } from "@/lib/social/engagement";

export const SOCIAL_CHANNEL = "social_organic";

export interface SocialPostAttribution extends EngagementNumbers {
  id: string;
  title: string;
  platforms: string[];
  campaign: string;
  publishedAt: string | null;
  mock: boolean;
  leads: number;
  revenueCents: number;
  /** leads / clicks, null without clicks. */
  clickToLead: number | null;
}

export interface SocialAttribution {
  model: AttributionModel;
  engagement: SocialEngagement["totals"];
  /** Leads and revenue on the social_organic channel (all touches, not only matched posts). */
  channelLeads: number;
  channelRevenueCents: number;
  posts: SocialPostAttribution[];
  campaigns: Array<{ campaign: string; posts: number; leads: number; revenueCents: number } & EngagementNumbers>;
  daily: SocialEngagement["daily"];
  byPlatform: SocialEngagement["byPlatform"];
  mock: boolean;
  postsPublished: number;
}

/** touch id → credited cents under `model` (per lead, touches in time order). */
export function touchCredit(
  touches: ModelTouch[],
  revenueByLead: Map<string, number>,
  model: AttributionModel,
): Map<string, number> {
  const byLead = new Map<string, ModelTouch[]>();
  for (const t of touches) {
    const list = byLead.get(t.leadId) ?? [];
    list.push(t);
    byLead.set(t.leadId, list);
  }
  const out = new Map<string, number>();
  for (const [leadId, list] of byLead) {
    const rev = revenueByLead.get(leadId) ?? 0;
    if (rev <= 0) continue;
    list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
    const credit = creditByModel(list, rev)[model];
    list.forEach((t, i) => out.set(t.id, credit[i] ?? 0));
  }
  return out;
}

export interface SocialTouch {
  id: string;
  leadId: string;
  campaign: string | null;
  utmContent: string | null;
}

/**
 * Pure join: which posts each social touch belongs to (post id via
 * utm_content first, else every post of the campaign).
 */
export function matchTouchesToPosts(
  touches: SocialTouch[],
  posts: Array<{ id: string; campaign: string }>,
): Map<string, string[]> {
  const ids = new Set(posts.map((p) => p.id));
  const byCampaign = new Map<string, string[]>();
  for (const p of posts) byCampaign.set(p.campaign, [...(byCampaign.get(p.campaign) ?? []), p.id]);
  const out = new Map<string, string[]>();
  for (const t of touches) {
    if (t.utmContent && ids.has(t.utmContent)) out.set(t.id, [t.utmContent]);
    else if (t.campaign && byCampaign.has(t.campaign.trim().toLowerCase())) out.set(t.id, byCampaign.get(t.campaign.trim().toLowerCase())!);
  }
  return out;
}

export async function getSocialAttribution(
  workspaceId: string,
  window: ReportWindow = {},
  model: AttributionModel = "linear",
): Promise<SocialAttribution> {
  const [engagement, data] = await Promise.all([
    getSocialEngagement(workspaceId, window),
    getReportData(workspaceId, window),
  ]);
  const socialTouchesRaw = await prisma.attributionTouch.findMany({
    where: {
      workspaceId,
      channel: SOCIAL_CHANNEL,
      ...(window.from || window.to
        ? { occurredAt: { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lte: window.to } : {}) } }
        : {}),
      ...(window.pipelineId ? { lead: { pipelineId: window.pipelineId } } : {}),
    },
    select: { id: true, leadId: true, campaign: true, meta: true },
    take: 20_000,
  });
  const socialTouches: SocialTouch[] = socialTouchesRaw.map((t) => {
    const meta = (t.meta ?? {}) as Record<string, unknown>;
    return { id: t.id, leadId: t.leadId, campaign: t.campaign, utmContent: typeof meta.utm_content === "string" ? meta.utm_content : null };
  });
  const credit = touchCredit(data.modelTouches, data.revenueByLead, model);

  const channelLeads = new Set(socialTouches.map((t) => t.leadId)).size;
  const channelRevenueCents = socialTouches.reduce((s, t) => s + (credit.get(t.id) ?? 0), 0);

  const matched = matchTouchesToPosts(socialTouches, engagement.byPost);
  const leadsByPost = new Map<string, Set<string>>();
  const revenueByPost = new Map<string, number>();
  for (const t of socialTouches) {
    const postIds = matched.get(t.id);
    if (!postIds?.length) continue;
    const share = (credit.get(t.id) ?? 0) / postIds.length;
    for (const pid of postIds) {
      (leadsByPost.get(pid) ?? leadsByPost.set(pid, new Set()).get(pid)!).add(t.leadId);
      revenueByPost.set(pid, (revenueByPost.get(pid) ?? 0) + share);
    }
  }
  const posts: SocialPostAttribution[] = engagement.byPost.map((p) => {
    const leads = leadsByPost.get(p.id)?.size ?? 0;
    return {
      ...p,
      leads,
      revenueCents: Math.round(revenueByPost.get(p.id) ?? 0),
      clickToLead: p.clicks > 0 ? leads / p.clicks : null,
    };
  });
  const campaignAgg = new Map<string, { leads: Set<string>; revenueCents: number }>();
  for (const p of posts) {
    const c = campaignAgg.get(p.campaign) ?? { leads: new Set<string>(), revenueCents: 0 };
    for (const l of leadsByPost.get(p.id) ?? []) c.leads.add(l);
    c.revenueCents += p.revenueCents;
    campaignAgg.set(p.campaign, c);
  }
  return {
    model,
    engagement: engagement.totals,
    channelLeads,
    channelRevenueCents,
    posts,
    campaigns: engagement.byCampaign.map((c) => ({
      ...c,
      leads: campaignAgg.get(c.campaign)?.leads.size ?? 0,
      revenueCents: campaignAgg.get(c.campaign)?.revenueCents ?? 0,
    })),
    daily: engagement.daily,
    byPlatform: engagement.byPlatform,
    mock: engagement.mock,
    postsPublished: engagement.postsPublished,
  };
}
