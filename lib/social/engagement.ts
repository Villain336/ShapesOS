// ShapesOS — social engagement ingestion + aggregation (Phase 4b).
//
// Ingest: for every published post (last INGEST_LOOKBACK_DAYS days), ask the
// provider for daily metrics per channel post and upsert one
// social_post_metrics row per (post, channel, day). Idempotent: a re-sync
// overwrites the same rows with the provider's latest totals. Mock rows are
// stored with source "mock" and labelled as sample data everywhere.
//
// Aggregate: totals, a daily series, per-platform, per-campaign and per-post
// rollups for a date window. Attribution (lib/attribution/social.ts) and the
// analytics home read these.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { log } from "@/lib/observability/log";
import { postTitle, readRefs, refreshStatuses, type RefreshResult } from "./publications";
import { getSocialProvider, type DailyMetric, type SocialProvider } from "./provider";
import { withWorkspaceSidecars } from "@/lib/integrations/sidecar-tenancy";
import { slugCampaign, defaultCampaign } from "./utm";

/** Posts older than this stop being re-polled (platform numbers settle). */
export const INGEST_LOOKBACK_DAYS = 30;
/** Per-post re-poll interval. */
export const INGEST_MIN_INTERVAL_MS = 60 * 60_000;

export interface IngestResult {
  posts: number;
  rows: number;
  errors: number;
}

function utcDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Ingest engagement for one workspace. `force` ignores the re-poll interval. */
export async function ingestEngagement(
  workspaceId: string,
  provider: SocialProvider,
  now: Date = new Date(),
  opts: { force?: boolean; postId?: string } = {},
): Promise<IngestResult> {
  const result: IngestResult = { posts: 0, rows: 0, errors: 0 };
  const since = new Date(now.getTime() - INGEST_LOOKBACK_DAYS * 86_400_000);
  const due = new Date(now.getTime() - INGEST_MIN_INTERVAL_MS);
  const posts = await withWorkspaceScope(workspaceId, (tx) =>
    tx.socialPublication.findMany({
      where: {
        workspaceId,
        status: "published",
        provider: provider.name,
        publishedAt: { gte: since },
        ...(opts.postId ? { id: opts.postId } : {}),
        ...(opts.force ? {} : { OR: [{ metricsSyncedAt: null }, { metricsSyncedAt: { lt: due } }] }),
      },
      orderBy: { publishedAt: "desc" },
      take: 200,
    }),
  );
  for (const post of posts) {
    const refs = readRefs(post.providerRefs);
    const rows: Array<{ integrationId: string; platform: string; m: DailyMetric }> = [];
    let failed = false;
    for (const ref of refs) {
      try {
        const days = Math.min(INGEST_LOOKBACK_DAYS, Math.ceil((now.getTime() - (post.publishedAt ?? now).getTime()) / 86_400_000) + 1);
        const daily = await provider.postMetrics(ref.postId, days, { publishedAt: post.publishedAt, now });
        for (const m of daily) rows.push({ integrationId: ref.integrationId || ref.postId, platform: ref.platform, m });
      } catch (e) {
        failed = true;
        log.warn("social metrics fetch failed", {
          workspaceId,
          postId: post.id,
          provider: provider.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    await withWorkspaceScope(workspaceId, async (tx) => {
      for (const r of rows) {
        const data = {
          platform: r.platform,
          impressions: r.m.impressions,
          likes: r.m.likes,
          comments: r.m.comments,
          shares: r.m.shares,
          clicks: r.m.clicks,
          source: provider.name,
        };
        await tx.socialPostMetric.upsert({
          where: { publicationId_integrationId_day: { publicationId: post.id, integrationId: r.integrationId, day: utcDay(r.m.day) }, workspaceId },
          create: { workspaceId, publicationId: post.id, integrationId: r.integrationId, day: utcDay(r.m.day), ...data },
          update: data,
        });
      }
      // A partial failure still advances the clock for the channels that
      // answered; a total failure leaves it so the next sweep retries.
      if (!failed || rows.length > 0) {
        await tx.socialPublication.update({ where: { id: post.id, workspaceId }, data: { metricsSyncedAt: now } });
      }
    });
    result.posts++;
    result.rows += rows.length;
    if (failed) result.errors++;
  }
  return result;
}

export interface SyncResult {
  refresh: RefreshResult;
  ingest: IngestResult;
}

/** Status refresh + engagement ingest for one workspace (manual "Sync" and cron). */
export async function syncSocialWorkspace(
  workspaceId: string,
  provider: SocialProvider,
  now: Date = new Date(),
  opts: { force?: boolean } = {},
): Promise<SyncResult> {
  const refresh = await refreshStatuses(workspaceId, provider, now);
  const ingest = await ingestEngagement(workspaceId, provider, now, opts);
  return { refresh, ingest };
}

/** Cron sweep: every workspace with posts in flight or recently published. */
export async function runSocialSync(now: Date = new Date()): Promise<{ workspaces: number } & SyncResult> {
  const total: { workspaces: number } & SyncResult = {
    workspaces: 0,
    refresh: { checked: 0, published: 0, failed: 0 },
    ingest: { posts: 0, rows: 0, errors: 0 },
  };
  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  const since = new Date(now.getTime() - INGEST_LOOKBACK_DAYS * 86_400_000);
  for (const ws of workspaces) {
    const active = await withWorkspaceScope(ws.id, (tx) =>
      tx.socialPublication.count({
        where: { workspaceId: ws.id, OR: [{ status: "scheduled" }, { status: "published", publishedAt: { gte: since } }] },
      }),
    );
    if (active === 0) continue;
    try {
      // Phase 15.1: each workspace's provider is chosen inside its own
      // sidecar scope (its own Postiz; a shared one is refused on hosted).
      // The selection itself (getSocialProvider) is unchanged.
      const r = await withWorkspaceSidecars(ws.id, async () => {
        // Phase 15.4 (zernio): the provider is per workspace (its Zernio profile).
        const provider = getSocialProvider(ws.id);
        return provider ? syncSocialWorkspace(ws.id, provider, now) : null;
      });
      if (!r) continue;
      total.workspaces++;
      for (const k of Object.keys(total.refresh) as Array<keyof RefreshResult>) total.refresh[k] += r.refresh[k];
      for (const k of Object.keys(total.ingest) as Array<keyof IngestResult>) total.ingest[k] += r.ingest[k];
    } catch (e) {
      log.warn("social sync failed", { workspaceId: ws.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface EngagementNumbers {
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  /** likes + comments + shares + clicks */
  engagements: number;
}

export interface EngagementWindow {
  from?: Date;
  to?: Date;
}

export interface PostEngagement extends EngagementNumbers {
  id: string;
  title: string;
  platforms: string[];
  campaign: string;
  publishedAt: string | null;
  mock: boolean;
}

export interface SocialEngagement {
  totals: EngagementNumbers;
  daily: Array<{ day: string } & EngagementNumbers>;
  byPlatform: Array<{ platform: string } & EngagementNumbers>;
  /** Keyed by the UTM campaign slug the links carried. */
  byCampaign: Array<{ campaign: string; posts: number } & EngagementNumbers>;
  byPost: PostEngagement[];
  /** True when any row is sample data from the mock provider. */
  mock: boolean;
  postsPublished: number;
}

function zero(): EngagementNumbers {
  return { impressions: 0, likes: 0, comments: 0, shares: 0, clicks: 0, engagements: 0 };
}

function add(t: EngagementNumbers, r: { impressions: number; likes: number; comments: number; shares: number; clicks: number }) {
  t.impressions += r.impressions;
  t.likes += r.likes;
  t.comments += r.comments;
  t.shares += r.shares;
  t.clicks += r.clicks;
  t.engagements = t.likes + t.comments + t.shares + t.clicks;
}

/** The campaign slug a post's links were tagged with (mirrors buildChannelBody). */
export function campaignForPost(p: { utmCampaign: string | null; scheduledFor: Date | null; publishedAt: Date | null; createdAt: Date }): string {
  // Dispatch tags with the dispatch time; scheduledFor is set to it then.
  return slugCampaign(p.utmCampaign) ?? defaultCampaign(p.scheduledFor ?? p.publishedAt ?? p.createdAt);
}

export async function getSocialEngagement(workspaceId: string, window: EngagementWindow = {}): Promise<SocialEngagement> {
  const dayRange: Prisma.DateTimeFilter | undefined =
    window.from || window.to
      ? {
          ...(window.from ? { gte: utcDay(window.from.toISOString().slice(0, 10)) } : {}),
          ...(window.to ? { lte: utcDay(window.to.toISOString().slice(0, 10)) } : {}),
        }
      : undefined;
  const { metrics, posts, published } = await withWorkspaceScope(workspaceId, async (tx) => {
    const metrics = await tx.socialPostMetric.findMany({
      where: { workspaceId, ...(dayRange ? { day: dayRange } : {}) },
      select: { publicationId: true, platform: true, day: true, impressions: true, likes: true, comments: true, shares: true, clicks: true, source: true },
      take: 50_000,
    });
    const ids = [...new Set(metrics.map((m) => m.publicationId))];
    const posts = ids.length
      ? await tx.socialPublication.findMany({
          where: { workspaceId, id: { in: ids } },
          select: { id: true, content: true, media: true, channels: true, utmCampaign: true, scheduledFor: true, publishedAt: true, createdAt: true },
        })
      : [];
    const published = await tx.socialPublication.count({
      where: {
        workspaceId,
        status: "published",
        ...(window.from || window.to
          ? { publishedAt: { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lte: window.to } : {}) } }
          : {}),
      },
    });
    return { metrics, posts, published };
  });

  const totals = zero();
  const daily = new Map<string, EngagementNumbers>();
  const byPlatform = new Map<string, EngagementNumbers>();
  const byPostNums = new Map<string, EngagementNumbers & { platforms: Set<string>; mock: boolean }>();
  let mock = false;
  for (const m of metrics) {
    add(totals, m);
    const day = m.day.toISOString().slice(0, 10);
    add(daily.get(day) ?? daily.set(day, zero()).get(day)!, m);
    add(byPlatform.get(m.platform) ?? byPlatform.set(m.platform, zero()).get(m.platform)!, m);
    let p = byPostNums.get(m.publicationId);
    if (!p) {
      p = { ...zero(), platforms: new Set(), mock: false };
      byPostNums.set(m.publicationId, p);
    }
    add(p, m);
    p.platforms.add(m.platform);
    if (m.source === "mock") {
      p.mock = true;
      mock = true;
    }
  }
  const postById = new Map(posts.map((p) => [p.id, p]));
  const byPost: PostEngagement[] = [];
  const byCampaign = new Map<string, EngagementNumbers & { posts: number }>();
  for (const [id, n] of byPostNums) {
    const p = postById.get(id);
    if (!p) continue;
    const campaign = campaignForPost(p);
    const { platforms, mock: isMock, ...nums } = n;
    byPost.push({
      id,
      title: postTitle(p),
      platforms: [...platforms].sort(),
      campaign,
      publishedAt: p.publishedAt?.toISOString() ?? null,
      mock: isMock,
      ...nums,
    });
    const c = byCampaign.get(campaign) ?? { ...zero(), posts: 0 };
    add(c, nums);
    c.posts++;
    byCampaign.set(campaign, c);
  }
  byPost.sort((a, b) => b.engagements - a.engagements || b.impressions - a.impressions);
  return {
    totals,
    daily: [...daily.entries()].map(([day, n]) => ({ day, ...n })).sort((a, b) => a.day.localeCompare(b.day)),
    byPlatform: [...byPlatform.entries()].map(([platform, n]) => ({ platform, ...n })).sort((a, b) => b.engagements - a.engagements),
    byCampaign: [...byCampaign.entries()].map(([campaign, n]) => ({ campaign, ...n })).sort((a, b) => b.engagements - a.engagements),
    byPost,
    mock,
    postsPublished: published,
  };
}
