// ShapesOS — Phase 15.4 (zernio): Zernio as a social publisher.
//
// The same SocialProvider interface as Postiz (lib/social/provider.ts), so
// posts keep going through the ONE social service and its approvals
// (lib/social/publications.ts: drafts → approval → dispatch; the agent's
// post_owned_social / publish_external actions) — there is no second
// publishing path. Zernio is per workspace (its profile), so this provider is
// constructed for one workspace and every channel it lists or posts to is one
// of that workspace's connected accounts.
//
//   listChannels  listAccounts?profileId=<ours> (posting platforms only)
//   uploadMedia   getMediaPresignedUrl (POST /v1/media/presign) + PUT the bytes
//   createPosts   createPost (POST /v1/posts), one per channel (each channel's
//                 body carries its own UTM tags), Idempotency-Key per channel
//   postStatuses  getPost (GET /v1/posts/{postId})
//   postMetrics   getPostTimeline (GET /v1/analytics/post-timeline)
// Per-account daily publish caps (spec "Rate Limits": Instagram 100/day,
// X 50/day, Pinterest 25/day, 50/day for most, 25/hour velocity) are
// enforced by Zernio; a refusal comes back as the post's error.

import { createHash } from "node:crypto";
import type {
  CreatePostsInput,
  DailyMetric,
  ProviderChannel,
  ProviderMediaRef,
  ProviderPostRef,
  ProviderPostStatus,
  SocialProvider,
  UploadInput,
} from "./provider";
import { normalizePlatform } from "./platforms";
import type { ZernioClient } from "@/lib/zernio/client";

/** Account categories Zernio can publish to (createPost): social + communication. */
const POSTING_CATEGORIES = new Set(["social", "communication"]);

export class ZernioSocialProvider implements SocialProvider {
  readonly name = "zernio" as const;

  constructor(
    private readonly workspaceId: string,
    private readonly deps: { client?: ZernioClient } = {},
  ) {}

  private async scope() {
    const { getZernioScope } = await import("@/lib/zernio/tenancy");
    return getZernioScope(this.workspaceId, { client: this.deps.client });
  }

  async listChannels(): Promise<ProviderChannel[]> {
    const { syncZernioAccounts } = await import("@/lib/zernio/tenancy");
    const accounts = await syncZernioAccounts(await this.scope());
    return accounts
      .filter((a) => POSTING_CATEGORIES.has(a.category) && a.status !== "disconnected")
      .map((a) => ({
        id: a.accountId,
        identifier: a.platform,
        platform: normalizePlatform(a.platform),
        name: a.displayName ?? a.username ?? a.platform,
        picture: null,
      }));
  }

  async uploadMedia(file: UploadInput): Promise<ProviderMediaRef> {
    const scope = await this.scope();
    const { uploadUrl, publicUrl } = await scope.client.getMediaPresignedUrl({
      filename: file.filename.slice(0, 200) || "upload",
      contentType: file.mimeType,
      size: file.bytes.length,
    });
    await scope.client.uploadToPresignedUrl(uploadUrl, new Uint8Array(file.bytes), file.mimeType);
    return { path: publicUrl };
  }

  async createPosts(input: CreatePostsInput): Promise<ProviderPostRef[]> {
    const scope = await this.scope();
    const { liveProfileAccounts } = await import("@/lib/zernio/tenancy");
    // Every target must be a posting account on THIS workspace's profile.
    const owned = new Map((await liveProfileAccounts(scope)).filter((a) => a.isActive).map((a) => [a._id, a]));
    for (const p of input.posts) {
      const acct = owned.get(p.channel.id);
      if (!acct) throw new Error("A selected channel is not connected to this workspace's Zernio profile.");
    }
    const media = input.media.map((m) => ({ url: m.path }));
    const refs: ProviderPostRef[] = [];
    for (const p of input.posts) {
      const acct = owned.get(p.channel.id)!;
      const body: Record<string, unknown> = {
        content: p.body,
        platforms: [{ platform: acct.platform, accountId: acct._id }],
        ...(media.length ? { mediaItems: media } : {}),
        ...(input.type === "schedule" && input.date ? { scheduledFor: new Date(input.date).toISOString() } : { publishNow: true }),
      };
      // Stable per (channel, body, time): a retried dispatch replays instead of double-posting.
      const key = `shapesos-post-${createHash("sha256").update(`${acct._id}|${p.body}|${input.date ?? ""}`).digest("hex").slice(0, 48)}`;
      const r = await scope.client.createPost(body, key);
      if (!r.post?._id) throw new Error(r.error ?? "Zernio accepted the post but returned no post id.");
      refs.push({ postId: r.post._id, integrationId: acct._id });
    }
    return refs;
  }

  async postStatuses(postIds: string[]): Promise<Map<string, ProviderPostStatus>> {
    const out = new Map<string, ProviderPostStatus>();
    if (postIds.length === 0) return out;
    const scope = await this.scope();
    for (const id of postIds.slice(0, 100)) {
      try {
        const post = await scope.client.getPost(id);
        const target = post.platforms?.[0];
        const state: ProviderPostStatus["state"] =
          post.status === "published"
            ? "published"
            : post.status === "failed" || post.status === "partial" || post.status === "cancelled"
              ? "error"
              : post.status === "draft"
                ? "draft"
                : post.status === "scheduled" || post.status === "publishing"
                  ? "queued"
                  : "unknown";
        out.set(id, { state, releaseUrl: target?.platformPostUrl ?? null, publishedAt: post.publishedAt ?? target?.publishedAt ?? null });
      } catch {
        // Left out: refreshStatuses keeps the post scheduled and asks again later.
      }
    }
    return out;
  }

  async postMetrics(postId: string, days: number, ctx: { publishedAt: Date | null; now: Date }): Promise<DailyMetric[]> {
    if (!ctx.publishedAt) return [];
    const scope = await this.scope();
    const from = new Date(Math.max(ctx.publishedAt.getTime(), ctx.now.getTime() - Math.max(1, days) * 86_400_000));
    const rows = await scope.client.getPostTimeline(postId, { fromDate: from.toISOString(), toDate: ctx.now.toISOString() });
    const byDay = new Map<string, DailyMetric>();
    for (const r of rows) {
      if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(r.date)) continue;
      const day = r.date.slice(0, 10);
      const m = byDay.get(day) ?? { day, impressions: 0, likes: 0, comments: 0, shares: 0, clicks: 0 };
      m.impressions += Number(r.impressions ?? r.views ?? 0) || 0;
      m.likes += Number(r.likes ?? 0) || 0;
      m.comments += Number(r.comments ?? 0) || 0;
      m.shares += Number(r.shares ?? 0) || 0;
      m.clicks += Number(r.clicks ?? 0) || 0;
      byDay.set(day, m);
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  }
}
