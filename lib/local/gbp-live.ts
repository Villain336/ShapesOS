// ShapesOS — Phase 4b: live Google Business Profile provider for the
// milestone-16 GBP module (lib/local/gbp.ts: posts + performance insights).
//
//   listPosts  → GET  https://mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/localPosts
//   createPost → POST https://mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/localPosts
//   insights   → GET  https://businessprofileperformance.googleapis.com/v1/locations/{l}:fetchMultiDailyMetricsTimeSeries
//                (dailyMetrics repeated; dailyRange.start_date / end_date)
// Location ids here are full refs: accounts/{accountId}/locations/{locationId}.
// Auth: the workspace's Google Business Profile OAuth connection (vault),
// refresh-on-401. Everything stays behind FEATURE_GBP_MANAGEMENT.

import { prisma } from "@/lib/prisma";
import { liveRequest, type LiveDeps, type TokenSource, tokenSourceFrom } from "@/lib/connectors/m21/live/http";
import { buildLocalPost, parseLocationRef, GBP_V4_BASE } from "@/lib/connectors/m21/live/gbp";
import { loadLiveCredential } from "@/lib/connectors/m21/live/credentials";
import { MockGbpProvider, type GbpInsight, type GbpPost, type GbpPostInput, type GbpProvider, gbpManagementEnabled } from "./gbp";

export const GBP_PERFORMANCE_BASE = "https://businessprofileperformance.googleapis.com/v1";
const PROVIDER = "Google Business Profile";

const IMPRESSION_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
] as const;
const DAILY_METRICS = [...IMPRESSION_METRICS, "BUSINESS_DIRECTION_REQUESTS", "CALL_CLICKS", "WEBSITE_CLICKS"] as const;

const CTA: Record<string, string> = {
  call: "CALL",
  learn_more: "LEARN_MORE",
  book: "BOOK",
  order: "ORDER",
  shop: "SHOP",
  sign_up: "SIGN_UP",
};

type Json = Record<string, unknown>;

function ymd(d: Date) {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export class GbpLiveProvider implements GbpProvider {
  readonly name = "gbp";
  readonly isLive = true;

  constructor(
    private readonly auth: TokenSource,
    private readonly deps: LiveDeps = {},
  ) {}

  isConfigured(): boolean {
    return gbpManagementEnabled();
  }

  async listPosts(locationId: string): Promise<GbpPost[]> {
    const ref = parseLocationRef(locationId);
    const out: Json[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await liveRequest<{ localPosts?: Json[]; nextPageToken?: string }>(
        {
          provider: PROVIDER,
          url: `${GBP_V4_BASE}/accounts/${ref.accountId}/locations/${ref.locationId}/localPosts`,
          query: { pageSize: 100, pageToken },
          auth: this.auth,
        },
        this.deps,
      );
      out.push(...(res.localPosts ?? []));
      pageToken = res.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return out.map((p) => this.shape(locationId, p));
  }

  /** Publishes now. Scheduling is not offered by the live API path. */
  async createPost(input: GbpPostInput): Promise<GbpPost> {
    if (input.scheduledAt) {
      throw new Error("Scheduled Google Business Profile posts are not supported live — publish now or keep a draft.");
    }
    const ref = parseLocationRef(input.locationId);
    const cta = input.callToAction ? CTA[input.callToAction.toLowerCase()] : undefined;
    const body = buildLocalPost({
      topicType: "update",
      title: input.title,
      // STANDARD posts have no title field; lead with it so it is not lost.
      summary: `${input.title}\n\n${input.summary}`.trim(),
      actionUrl: cta && cta !== "CALL" ? (input.actionUrl ?? null) : null,
      actionType: cta ?? null,
    });
    if (cta === "CALL") body.callToAction = { actionType: "CALL" };
    const res = await liveRequest<Json>(
      {
        provider: PROVIDER,
        method: "POST",
        url: `${GBP_V4_BASE}/accounts/${ref.accountId}/locations/${ref.locationId}/localPosts`,
        json: body,
        auth: this.auth,
      },
      this.deps,
    );
    return this.shape(input.locationId, { ...res, summary: res.summary ?? body.summary }, input.title);
  }

  async insights(locationId: string, days = 30): Promise<GbpInsight[]> {
    const ref = parseLocationRef(locationId);
    const end = new Date(Date.now() - 86_400_000); // performance data lags; end yesterday
    const start = new Date(end.getTime() - (Math.max(1, Math.min(days, 540)) - 1) * 86_400_000);
    const url = new URL(`${GBP_PERFORMANCE_BASE}/locations/${ref.locationId}:fetchMultiDailyMetricsTimeSeries`);
    for (const m of DAILY_METRICS) url.searchParams.append("dailyMetrics", m);
    const s = ymd(start);
    const e = ymd(end);
    url.searchParams.set("dailyRange.start_date.year", String(s.year));
    url.searchParams.set("dailyRange.start_date.month", String(s.month));
    url.searchParams.set("dailyRange.start_date.day", String(s.day));
    url.searchParams.set("dailyRange.end_date.year", String(e.year));
    url.searchParams.set("dailyRange.end_date.month", String(e.month));
    url.searchParams.set("dailyRange.end_date.day", String(e.day));
    const res = await liveRequest<{
      multiDailyMetricTimeSeries?: Array<{
        dailyMetricTimeSeries?: Array<{
          dailyMetric?: string;
          timeSeries?: { datedValues?: Array<{ date?: { year?: number; month?: number; day?: number }; value?: string | number }> };
        }>;
      }>;
    }>({ provider: PROVIDER, url: url.toString(), auth: this.auth }, this.deps);

    const byDate = new Map<string, GbpInsight>();
    const row = (date: string) => {
      let r = byDate.get(date);
      if (!r) {
        r = { locationId, date, views: 0, searches: 0, directionRequests: 0, calls: 0, websiteClicks: 0 };
        byDate.set(date, r);
      }
      return r;
    };
    for (const multi of res.multiDailyMetricTimeSeries ?? []) {
      for (const series of multi.dailyMetricTimeSeries ?? []) {
        const metric = series.dailyMetric ?? "";
        for (const dv of series.timeSeries?.datedValues ?? []) {
          const d = dv.date;
          if (!d?.year || !d.month || !d.day) continue;
          const key = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
          const v = Number(dv.value ?? 0) || 0;
          const r = row(key);
          if ((IMPRESSION_METRICS as readonly string[]).includes(metric)) {
            r.views += v;
            if (metric.endsWith("_SEARCH")) r.searches += v;
          } else if (metric === "BUSINESS_DIRECTION_REQUESTS") r.directionRequests += v;
          else if (metric === "CALL_CLICKS") r.calls += v;
          else if (metric === "WEBSITE_CLICKS") r.websiteClicks += v;
        }
      }
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  private shape(locationId: string, p: Json, title?: string): GbpPost {
    const state = String(p.state ?? "");
    const summary = String(p.summary ?? "");
    return {
      id: String(p.name ?? ""),
      locationId,
      title: title ?? summary.split("\n")[0].slice(0, 200),
      summary,
      status: state === "LIVE" ? "published" : state === "REJECTED" ? "failed" : state === "PROCESSING" ? "scheduled" : "published",
      scheduledAt: null,
      mock: false,
    };
  }
}

/**
 * The provider for one workspace: live over its Google Business Profile
 * OAuth connection when one is active, the mock otherwise.
 */
export async function gbpProviderForWorkspace(workspaceId: string): Promise<GbpProvider> {
  const connection = await prisma.connectorConnection.findFirst({
    where: { workspaceId, connectorKey: "google-business-profile", status: "active" },
    orderBy: { connectedAt: "desc" },
    select: { id: true },
  });
  if (connection) {
    const { credential, refreshCredential } = await loadLiveCredential(connection.id);
    const auth = tokenSourceFrom(credential, { refreshCredential });
    if (auth) return new GbpLiveProvider(auth);
  }
  return new MockGbpProvider();
}
