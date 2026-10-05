// ShapesOS — social provider layer (Phase 4b).
//
// One interface over the publishing backend:
//   - PostizProvider: the self-hosted Postiz sidecar over raw REST
//     (lib/integrations/postiz.ts; never its AGPL SDK). Used whenever
//     POSTIZ_URL + POSTIZ_API_KEY are set.
//   - MockSocialProvider: no credentials. Deterministic channels, instant
//     "publish" and sample engagement, every value flagged mock so the UI
//     labels it. Allowed outside production, or in production only with
//     SOCIAL_MOCK_MODE=1 (a production workspace never sees invented numbers
//     by accident; without Postiz it gets an honest "connect Postiz").
//   - ZernioSocialProvider (Phase 15.4, lib/social/zernio.ts): the Zernio
//     platform key (ZERNIO_API_KEY), per workspace (its own Zernio profile).
//     The DEFAULT publisher on hosted (DEPLOYMENT_MODE=hosted) when the key is
//     set — the shared Postiz sidecar isn't tenant-safe there. Self-hosted
//     keeps Postiz first when it is configured; Buffer stays a connector.

import { createHash } from "node:crypto";
import {
  createPostizPosts,
  getPostizPostAnalytics,
  listPostizChannels,
  listPostizPostStatuses,
  postizStatus,
  uploadPostizFile,
  type PostizMetricSeries,
} from "@/lib/integrations/postiz";
import { normalizePlatform } from "./platforms";
import { deploymentMode } from "@/lib/billing/trial";
import { zernioMode } from "@/lib/zernio/config";
import { ZernioSocialProvider } from "./zernio";

export type ProviderName = "postiz" | "mock" | "zernio";

export interface ProviderChannel {
  /** Provider integration id (the dispatch target). */
  id: string;
  /** Provider identifier, e.g. "x", "linkedin-page". */
  identifier: string;
  /** Normalized platform key (lib/social/platforms.ts). */
  platform: string;
  name: string;
  picture: string | null;
}

export interface UploadInput {
  bytes: Buffer;
  filename: string;
  mimeType: string;
}

export interface ProviderMediaRef {
  id?: string;
  path: string;
}

export interface CreatePostsInput {
  type: "now" | "schedule";
  /** ISO, required for schedule. */
  date?: string;
  /** One entry per channel; bodies differ (per-platform UTM tags). */
  posts: Array<{ channel: Pick<ProviderChannel, "id" | "identifier">; body: string }>;
  media: ProviderMediaRef[];
}

export interface ProviderPostRef {
  postId: string;
  integrationId: string;
}

export interface ProviderPostStatus {
  state: "queued" | "published" | "error" | "draft" | "unknown";
  releaseUrl: string | null;
  publishedAt: string | null;
}

export interface DailyMetric {
  /** YYYY-MM-DD (UTC). */
  day: string;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
}

export interface SocialProvider {
  readonly name: ProviderName;
  listChannels(): Promise<ProviderChannel[]>;
  uploadMedia(file: UploadInput): Promise<ProviderMediaRef>;
  createPosts(input: CreatePostsInput): Promise<ProviderPostRef[]>;
  /** Status for the given provider post ids (missing ids are left out). */
  postStatuses(postIds: string[], window: { from: Date; to: Date }): Promise<Map<string, ProviderPostStatus>>;
  /** Daily engagement for one provider post over the last `days` days. */
  postMetrics(postId: string, days: number, ctx: { publishedAt: Date | null; now: Date }): Promise<DailyMetric[]>;
}

// ---------------------------------------------------------------------------
// Metric label mapping (Postiz labels vary per platform)
// ---------------------------------------------------------------------------

const METRIC_LABELS: Record<keyof Omit<DailyMetric, "day">, string[]> = {
  // First present label wins (no double counting Likes + Reactions).
  impressions: ["impressions", "views", "video views", "plays", "reach"],
  likes: ["likes", "reactions", "favorites", "favourites", "hearts"],
  comments: ["comments", "replies"],
  shares: ["shares", "reposts", "retweets", "quotes", "boosts"],
  clicks: ["clicks", "link clicks", "url clicks", "link_clicks", "outbound clicks"],
};

/** Fold provider metric series into one row per day. */
export function seriesToDaily(series: PostizMetricSeries[]): DailyMetric[] {
  const byLabel = new Map(series.map((s) => [s.label.trim().toLowerCase(), s]));
  const days = new Map<string, DailyMetric>();
  const row = (day: string) => {
    let r = days.get(day);
    if (!r) {
      r = { day, impressions: 0, likes: 0, comments: 0, shares: 0, clicks: 0 };
      days.set(day, r);
    }
    return r;
  };
  for (const [metric, labels] of Object.entries(METRIC_LABELS) as Array<[keyof Omit<DailyMetric, "day">, string[]]>) {
    const s = labels.map((l) => byLabel.get(l)).find(Boolean);
    if (!s) continue;
    for (const d of s.data) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
      row(d.date)[metric] = d.total;
    }
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// ---------------------------------------------------------------------------
// Postiz
// ---------------------------------------------------------------------------

export class PostizProvider implements SocialProvider {
  readonly name = "postiz" as const;

  async listChannels(): Promise<ProviderChannel[]> {
    const rows = await listPostizChannels();
    return rows.map((c) => ({
      id: c.id,
      identifier: c.identifier,
      platform: normalizePlatform(c.identifier),
      name: c.name ?? c.identifier,
      picture: c.picture,
    }));
  }

  uploadMedia(file: UploadInput): Promise<ProviderMediaRef> {
    return uploadPostizFile(file.bytes, file.filename, file.mimeType);
  }

  async createPosts(input: CreatePostsInput): Promise<ProviderPostRef[]> {
    const image = input.media.map((m) => ({ ...(m.id ? { id: m.id } : {}), path: m.path }));
    const payload: Record<string, unknown> = {
      type: input.type,
      date: input.type === "schedule" && input.date ? new Date(input.date).toISOString() : new Date().toISOString(),
      shortLink: false,
      tags: [],
      posts: input.posts.map((p) => ({
        integration: { id: p.channel.id },
        value: [{ content: p.body, image }],
        settings: { __type: p.channel.identifier || "x" },
      })),
    };
    const refs = await createPostizPosts(payload);
    // Postiz answers one { postId, integration } per channel, in order.
    return refs.map((r, i) => ({ postId: r.postId, integrationId: r.integrationId ?? input.posts[i]?.channel.id ?? "" }));
  }

  async postStatuses(postIds: string[], window: { from: Date; to: Date }): Promise<Map<string, ProviderPostStatus>> {
    const wanted = new Set(postIds);
    const out = new Map<string, ProviderPostStatus>();
    if (wanted.size === 0) return out;
    for (const p of await listPostizPostStatuses(window.from, window.to)) {
      if (!wanted.has(p.id)) continue;
      out.set(p.id, {
        state:
          p.state === "PUBLISHED" ? "published" : p.state === "ERROR" ? "error" : p.state === "QUEUE" ? "queued" : p.state === "DRAFT" ? "draft" : "unknown",
        releaseUrl: p.releaseUrl,
        publishedAt: p.publishDate,
      });
    }
    return out;
  }

  async postMetrics(postId: string, days: number): Promise<DailyMetric[]> {
    return seriesToDaily(await getPostizPostAnalytics(postId, days));
  }
}

// ---------------------------------------------------------------------------
// Mock (no credentials)
// ---------------------------------------------------------------------------

export const MOCK_CHANNELS: ProviderChannel[] = [
  { id: "mock-x", identifier: "x", platform: "x", name: "ShapesOS demo on X (mock)", picture: null },
  { id: "mock-linkedin", identifier: "linkedin-page", platform: "linkedin", name: "ShapesOS demo page (mock)", picture: null },
  { id: "mock-instagram", identifier: "instagram", platform: "instagram", name: "shapesos.demo (mock)", picture: null },
];

function seeded(...parts: string[]): number {
  const h = createHash("sha256").update(parts.join("|")).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Deterministic sample engagement: a launch-day peak that decays, scaled by
 * a per-post seed. Same inputs → same numbers (tests and re-syncs agree).
 */
export function mockDailyMetrics(postId: string, publishedAt: Date, now: Date, days: number): DailyMetric[] {
  const out: DailyMetric[] = [];
  const start = new Date(Date.UTC(publishedAt.getUTCFullYear(), publishedAt.getUTCMonth(), publishedAt.getUTCDate()));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const earliest = new Date(end.getTime() - (Math.max(1, days) - 1) * 86_400_000);
  const scale = 0.5 + seeded(postId, "scale");
  for (let t = start.getTime(), i = 0; t <= end.getTime(); t += 86_400_000, i++) {
    if (t < earliest.getTime()) continue;
    const decay = Math.pow(0.55, i);
    const jitter = 0.8 + 0.4 * seeded(postId, String(i));
    const impressions = Math.round(1200 * scale * decay * jitter);
    out.push({
      day: dayKey(new Date(t)),
      impressions,
      likes: Math.round(impressions * 0.04),
      comments: Math.round(impressions * 0.006),
      shares: Math.round(impressions * 0.008),
      clicks: Math.round(impressions * 0.012),
    });
  }
  return out;
}

export class MockSocialProvider implements SocialProvider {
  readonly name = "mock" as const;

  async listChannels(): Promise<ProviderChannel[]> {
    return MOCK_CHANNELS.map((c) => ({ ...c }));
  }

  async uploadMedia(file: UploadInput): Promise<ProviderMediaRef> {
    const digest = createHash("sha256").update(file.bytes).digest("hex").slice(0, 16);
    return { id: `mock-media-${digest}`, path: `mock://media/${digest}` };
  }

  async createPosts(input: CreatePostsInput): Promise<ProviderPostRef[]> {
    return input.posts.map((p) => ({
      postId: `mock-post-${createHash("sha256").update(`${p.channel.id}|${p.body}|${input.date ?? ""}|${Math.random()}`).digest("hex").slice(0, 16)}`,
      integrationId: p.channel.id,
    }));
  }

  async postStatuses(postIds: string[], _window?: { from: Date; to: Date }): Promise<Map<string, ProviderPostStatus>> {
    // Mock posts publish the moment they are due; the caller only asks for
    // posts whose scheduled time has passed.
    return new Map(postIds.map((id) => [id, { state: "published", releaseUrl: null, publishedAt: null }]));
  }

  async postMetrics(postId: string, days: number, ctx: { publishedAt: Date | null; now: Date }): Promise<DailyMetric[]> {
    if (!ctx.publishedAt) return [];
    return mockDailyMetrics(postId, ctx.publishedAt, ctx.now, days);
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Mock is allowed outside production, or explicitly in production. */
export function socialMockAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" || env.SOCIAL_MOCK_MODE === "1";
}

let override: SocialProvider | null | undefined;

/** Tests only: force a provider (null = none configured). */
export function setSocialProviderForTests(p: SocialProvider | null | undefined): void {
  override = p;
}

/**
 * The workspace's social provider, or null when none is available.
 * Phase 15.4 (zernio): pass the workspace — Zernio publishes per workspace
 * (its own profile). Order: Zernio first on hosted when ZERNIO_API_KEY is
 * set; then Postiz when configured (gated on hosted by the keys workstream);
 * then Zernio (self-hosted with only the Zernio key); then the labelled mock.
 * The keys workstream owns sidecar tenancy — this only adds Zernio.
 */
export function getSocialProvider(workspaceId?: string | null): SocialProvider | null {
  if (override !== undefined) return override;
  const zernio = workspaceId && zernioMode() === "live" ? new ZernioSocialProvider(workspaceId) : null;
  if (zernio && deploymentMode() === "hosted") return zernio;
  if (postizStatus().configured) return new PostizProvider();
  if (zernio) return zernio;
  if (socialMockAllowed()) return new MockSocialProvider();
  return null;
}

export const SOCIAL_NOT_CONNECTED_MESSAGE =
  "Social publishing isn't connected. Set POSTIZ_URL and POSTIZ_API_KEY, then connect your channels in Postiz.";
