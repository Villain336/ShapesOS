// Phase 4b: live GBP provider for the milestone-16 module (local posts +
// Performance API daily metrics) against recorded fixtures.
// Run: npx tsx --test lib/local/__tests__/gbp-live.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GbpLiveProvider } from "../gbp-live";
import { jsonResponse, scriptedFetch, liveDeps } from "@/lib/connectors/m21/live/__tests__/fixtures";

const LOC = "accounts/111/locations/222";

describe("GbpLiveProvider", () => {
  it("insights: one Performance API call, metrics aggregated per day", async () => {
    const f = scriptedFetch([
      jsonResponse(200, {
        multiDailyMetricTimeSeries: [
          {
            dailyMetricTimeSeries: [
              { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "10" }] } },
              { dailyMetric: "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "5" }, { date: { year: 2026, month: 9, day: 2 } }] } },
              { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "2" }] } },
              { dailyMetric: "WEBSITE_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 2 }, value: "7" }] } },
              { dailyMetric: "BUSINESS_DIRECTION_REQUESTS", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "1" }] } },
            ],
          },
        ],
      }),
    ]);
    const p = new GbpLiveProvider({ token: "t" }, liveDeps(f.fetchImpl).deps);
    const rows = await p.insights(LOC, 7);
    const c = f.calls[0];
    assert.equal(c.url.origin + c.url.pathname, "https://businessprofileperformance.googleapis.com/v1/locations/222:fetchMultiDailyMetricsTimeSeries");
    assert.equal(c.url.searchParams.getAll("dailyMetrics").length, 7);
    assert.ok(c.url.searchParams.get("dailyRange.start_date.year"));
    assert.ok(c.url.searchParams.get("dailyRange.end_date.day"));
    assert.equal(c.headers.authorization, "Bearer t");
    assert.deepEqual(rows, [
      { locationId: LOC, date: "2026-09-01", views: 15, searches: 10, directionRequests: 1, calls: 2, websiteClicks: 0 },
      { locationId: LOC, date: "2026-09-02", views: 0, searches: 0, directionRequests: 0, calls: 0, websiteClicks: 7 },
    ]);
  });

  it("createPost publishes a STANDARD local post; scheduled posts are refused live", async () => {
    const f = scriptedFetch([jsonResponse(200, { name: `${LOC}/localPosts/9`, state: "LIVE" })]);
    const p = new GbpLiveProvider({ token: "t" }, liveDeps(f.fetchImpl).deps);
    const post = await p.createPost({ locationId: LOC, title: "Fall hours", summary: "Open till 8", callToAction: "learn_more", actionUrl: "https://x.test" });
    assert.equal(f.calls[0].url.href, `https://mybusiness.googleapis.com/v4/${LOC}/localPosts`);
    assert.deepEqual(f.calls[0].body, {
      languageCode: "en",
      summary: "Fall hours\n\nOpen till 8",
      topicType: "STANDARD",
      callToAction: { actionType: "LEARN_MORE", url: "https://x.test" },
    });
    assert.deepEqual([post.id, post.status, post.mock], [`${LOC}/localPosts/9`, "published", false]);
    await assert.rejects(p.createPost({ locationId: LOC, title: "x", summary: "y", scheduledAt: new Date() }), /not supported live/);
    assert.equal(f.calls.length, 1);
  });

  it("listPosts pages through localPosts", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { localPosts: [{ name: "a", summary: "One", state: "LIVE" }], nextPageToken: "n" }),
      jsonResponse(200, { localPosts: [{ name: "b", summary: "Two", state: "REJECTED" }] }),
    ]);
    const posts = await new GbpLiveProvider({ token: "t" }, liveDeps(f.fetchImpl).deps).listPosts(LOC);
    assert.equal(f.calls[1].url.searchParams.get("pageToken"), "n");
    assert.deepEqual(posts.map((x) => [x.id, x.status]), [["a", "published"], ["b", "failed"]]);
  });
});
