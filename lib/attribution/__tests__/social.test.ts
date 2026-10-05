// ShapesOS Phase 4b — social → attribution joins (pure parts) and the
// analytics home window parser.
// Run: npx tsx --test lib/attribution/__tests__/social.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchTouchesToPosts, touchCredit } from "../social";
import { parseAnalyticsWindow } from "@/lib/analytics/overview";
import { campaignForPost } from "@/lib/social/engagement";

const at = (h: number) => new Date(Date.UTC(2026, 9, 1, h));

describe("matchTouchesToPosts", () => {
  const posts = [
    { id: "p1", campaign: "launch" },
    { id: "p2", campaign: "launch" },
    { id: "p3", campaign: "social-2026-10-01" },
  ];
  it("prefers utm_content (the post id), falls back to every post of the campaign", () => {
    const m = matchTouchesToPosts(
      [
        { id: "t1", leadId: "l1", campaign: "launch", utmContent: "p2" },
        { id: "t2", leadId: "l2", campaign: "Launch ", utmContent: null },
        { id: "t3", leadId: "l3", campaign: "other", utmContent: "unknown-post" },
        { id: "t4", leadId: "l4", campaign: null, utmContent: "p3" },
      ],
      posts,
    );
    assert.deepEqual(m.get("t1"), ["p2"]);
    assert.deepEqual(m.get("t2"), ["p1", "p2"]);
    assert.equal(m.has("t3"), false);
    assert.deepEqual(m.get("t4"), ["p3"]);
  });
});

describe("touchCredit", () => {
  it("credits each touch under the chosen model, summing to the lead's revenue", () => {
    const touches = [
      { id: "a", leadId: "L", channel: "email", campaign: null, contentId: null, occurredAt: at(1) },
      { id: "b", leadId: "L", channel: "social_organic", campaign: "launch", contentId: null, occurredAt: at(2) },
      { id: "c", leadId: "L", channel: "website", campaign: null, contentId: null, occurredAt: at(3) },
      { id: "d", leadId: "M", channel: "social_organic", campaign: "launch", contentId: null, occurredAt: at(1) },
    ];
    const revenue = new Map([["L", 1000]]);
    const linear = touchCredit(touches, revenue, "linear");
    assert.equal(linear.get("a")! + linear.get("b")! + linear.get("c")!, 1000);
    assert.equal(linear.get("b"), 333);
    assert.equal(linear.has("d"), false, "a lead with no revenue earns nothing");
    assert.equal(touchCredit(touches, revenue, "first_touch").get("a"), 1000);
    assert.equal(touchCredit(touches, revenue, "last_touch").get("c"), 1000);
    assert.equal(touchCredit(touches, revenue, "last_touch").get("b"), 0);
  });
});

describe("campaignForPost", () => {
  it("mirrors the dispatch tagging", () => {
    assert.equal(campaignForPost({ utmCampaign: "Fall Sale", scheduledFor: null, publishedAt: null, createdAt: at(0) }), "fall-sale");
    assert.equal(campaignForPost({ utmCampaign: null, scheduledFor: new Date("2026-11-02T08:00:00Z"), publishedAt: null, createdAt: at(0) }), "social-2026-11-02");
  });
});

describe("parseAnalyticsWindow", () => {
  const now = new Date("2026-10-05T00:00:00Z");
  it("defaults to 30 days and accepts days or from/to", () => {
    const d = parseAnalyticsWindow(new URLSearchParams(), now);
    assert.ok(!("error" in d));
    assert.equal((d as { from: Date }).from.toISOString(), "2026-09-05T00:00:00.000Z");
    const w = parseAnalyticsWindow(new URLSearchParams("days=7"), now) as { from: Date; to: Date };
    assert.equal(w.to, now);
    const r = parseAnalyticsWindow(new URLSearchParams("from=2026-01-01&to=2026-02-01"), now) as { from: Date; to: Date };
    assert.equal(r.from.toISOString(), "2026-01-01T00:00:00.000Z");
  });
  it("rejects bad input with a message (400, never 500)", () => {
    for (const qs of ["days=0", "days=1.5", "days=abc", "days=9999", "from=nope", "from=2026-02-01&to=2026-01-01", "from=2020-01-01&to=2026-01-01"]) {
      assert.ok("error" in parseAnalyticsWindow(new URLSearchParams(qs), now), qs);
    }
  });
});
