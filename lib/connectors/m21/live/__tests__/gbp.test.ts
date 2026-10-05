// Phase 4b: Google Business Profile — M21 adapter, authority GbpClient,
// and the pure profile-sync planner, against recorded API fixtures.
// Run: npx tsx --test lib/connectors/m21/live/__tests__/gbp.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GoogleBusinessProfileAdapter } from "../../native/google-business-profile";
import { planGbpSync, buildLocalPost, parseLocationRef } from "../gbp";
import { createLiveGbpClient, resolveGbpClient } from "@/lib/authority/fake";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith, refreshingCtx } from "./fixtures";

const LOC = "accounts/111/locations/222";
const V4 = "https://mybusiness.googleapis.com/v4/accounts/111/locations/222";

describe("GBP M21 adapter", () => {
  it("mock mode without a credential; mutations are echoed, never sent", async () => {
    const f = scriptedFetch([]);
    const a = new GoogleBusinessProfileAdapter(liveDeps(f.fetchImpl).deps);
    const r = await a.invoke("reply_to_review", { locationRef: LOC, reviewId: "r1", comment: "Thanks!" }, null, ctxWith());
    assert.equal(r.mock, true);
    assert.equal(f.calls.length, 0);
  });

  it("mutating tools are flagged mutating (confirmation-gated)", () => {
    const tools = new GoogleBusinessProfileAdapter().listTools();
    const m = Object.fromEntries(tools.map((t) => [t.name, t.mutating]));
    assert.deepEqual(m, { list_accounts: false, list_locations: false, list_reviews: false, reply_to_review: true, create_post: true });
  });

  it("list_locations: Business Information v1 with readMask + pagination", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { locations: [{ name: "locations/222", title: "Harbor", phoneNumbers: { primaryPhone: "555" }, categories: { primaryCategory: { displayName: "Dentist" } } }], nextPageToken: "n2" }),
      jsonResponse(200, { locations: [{ name: "locations/333", title: "Annex" }] }),
    ]);
    const r = await new GoogleBusinessProfileAdapter(liveDeps(f.fetchImpl).deps).invoke("list_locations", { accountId: "accounts/111" }, oauthCred("g"), ctxWith());
    assert.equal(r.ok, true, r.error);
    const c = f.calls[0];
    assert.equal(c.url.origin + c.url.pathname, "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/111/locations");
    assert.match(c.url.searchParams.get("readMask") ?? "", /title/);
    assert.equal(c.headers.authorization, "Bearer g");
    assert.equal(f.calls[1].url.searchParams.get("pageToken"), "n2");
    const rows = r.data as Array<{ locationRef: string; primaryPhone: string | null; primaryCategory: string | null }>;
    assert.deepEqual(rows.map((x) => x.locationRef), [LOC, "accounts/111/locations/333"]);
    assert.equal(rows[0].primaryCategory, "Dentist");
  });

  it("list_reviews: v4 reviews with summary + reply state", async () => {
    const f = scriptedFetch([
      jsonResponse(200, {
        reviews: [{ reviewId: "r1", reviewer: { displayName: "Sam" }, starRating: "FOUR", comment: "Nice", createTime: "t", updateTime: "u", reviewReply: { comment: "Thanks", reviewReplyState: "PENDING" } }],
        averageRating: 4.5,
        totalReviewCount: 10,
      }),
    ]);
    const r = await new GoogleBusinessProfileAdapter(liveDeps(f.fetchImpl).deps).invoke("list_reviews", { limit: 5 }, oauthCred(), ctxWith({ projectConfig: { locationRef: LOC } }));
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls[0].url.origin + f.calls[0].url.pathname, `${V4}/reviews`);
    assert.equal(f.calls[0].url.searchParams.get("pageSize"), "5");
    const data = r.data as { averageRating: number; reviews: Array<{ rating: number; reply: { state: string } }> };
    assert.equal(data.averageRating, 4.5);
    assert.equal(data.reviews[0].rating, 4);
    assert.equal(data.reviews[0].reply.state, "PENDING");
  });

  it("reply_to_review: PUT …/reviews/{id}/reply with {comment}; refresh on 401", async () => {
    const f = scriptedFetch([jsonResponse(401, {}), jsonResponse(200, { comment: "Thanks!", reviewReplyState: "PENDING", updateTime: "2026-10-03T00:00:00Z" })]);
    const ctx = refreshingCtx();
    const r = await new GoogleBusinessProfileAdapter(liveDeps(f.fetchImpl).deps).invoke("reply_to_review", { locationRef: LOC, reviewId: "r1", comment: " Thanks! " }, oauthCred(), ctx);
    assert.equal(r.ok, true, r.error);
    assert.equal(ctx.refreshCalls(), 1);
    const c = f.calls[1];
    assert.equal(c.method, "PUT");
    assert.equal(c.url.href, `${V4}/reviews/r1/reply`);
    assert.deepEqual(c.body, { comment: "Thanks!" });
    assert.deepEqual(r.data, { reviewId: "r1", state: "PENDING", updateTime: "2026-10-03T00:00:00Z" });
  });

  it("create_post: v4 localPosts body; events need dates; recurring fails closed", async () => {
    const f = scriptedFetch([jsonResponse(200, { name: `${LOC}/localPosts/p1`, state: "LIVE" })]);
    const a = new GoogleBusinessProfileAdapter(liveDeps(f.fetchImpl).deps);
    const r = await a.invoke(
      "create_post",
      { locationRef: LOC, topicType: "event", title: "Open house", summary: "Come by", startDate: "2026-10-10", endDate: "2026-10-11", actionUrl: "https://x.test/rsvp" },
      oauthCred(),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls[0].method, "POST");
    assert.equal(f.calls[0].url.href, `${V4}/localPosts`);
    assert.deepEqual(f.calls[0].body, {
      languageCode: "en",
      summary: "Come by",
      topicType: "EVENT",
      callToAction: { actionType: "LEARN_MORE", url: "https://x.test/rsvp" },
      event: { title: "Open house", schedule: { startDate: { year: 2026, month: 10, day: 10 }, endDate: { year: 2026, month: 10, day: 11 } } },
    });
    const noDates = await a.invoke("create_post", { locationRef: LOC, topicType: "offer", title: "Deal", summary: "x" }, oauthCred(), ctxWith());
    assert.equal(noDates.errorCode, "bad_request");
    assert.throws(() => buildLocalPost({ topicType: "update", summary: "x", recurring: true }), /recurring/);
    assert.equal(f.calls.length, 1);
  });

  it("locationRef must name account + location for v4 calls", async () => {
    assert.deepEqual(parseLocationRef("locations/9"), { accountId: null, locationId: "9" });
    assert.throws(() => parseLocationRef("https://evil.test/locations/1"));
    const f = scriptedFetch([]);
    const r = await new GoogleBusinessProfileAdapter(liveDeps(f.fetchImpl).deps).invoke("list_reviews", { locationRef: "locations/9" }, oauthCred(), ctxWith());
    assert.equal(r.errorCode, "bad_request");
    assert.equal(f.calls.length, 0);
  });
});

describe("planGbpSync (pure)", () => {
  it("maps NAP/hours/categories/description into one PATCH with an updateMask", () => {
    const ops = planGbpSync(LOC, {
      locationRef: LOC,
      nap: { name: "Harbor Dental", phone: "+1 555 0100", website: "https://harbor.test" },
      hours: { periods: [{ openDay: "MONDAY", openTime: { hours: 9 }, closeDay: "MONDAY", closeTime: { hours: 17 } }] },
      categories: ["gcid:dentist", "categories/gcid:cosmetic_dentist"],
      description: "Gentle care.",
    });
    assert.equal(ops.length, 1);
    const op = ops[0];
    assert.equal(op.kind, "patch_location");
    if (op.kind !== "patch_location") return;
    assert.deepEqual(op.updateMask, ["title", "phoneNumbers", "websiteUri", "regularHours", "categories", "profile"]);
    assert.deepEqual(op.body.categories, { primaryCategory: { name: "categories/gcid:dentist" }, additionalCategories: [{ name: "categories/gcid:cosmetic_dentist" }] });
  });

  it("attributes, posts and photos become their own operations", () => {
    const ops = planGbpSync(LOC, {
      attributes: { has_wheelchair_accessible_entrance: true },
      posts: [{ topic: "update", title: "Hi", body: "We are open late" }],
      photos: ["https://cdn.test/a.jpg"],
    });
    assert.deepEqual(ops.map((o) => o.kind), ["patch_attributes", "create_post", "create_media"]);
    const attr = ops[0];
    if (attr.kind === "patch_attributes") assert.deepEqual(attr.attributeMask, ["attributes/has_wheelchair_accessible_entrance"]);
  });

  it("rejects unknown keys, bare category names, and http photo URLs (nothing silently dropped)", () => {
    assert.throws(() => planGbpSync(LOC, { title: "x", secretSauce: 1 }), /unsupported profile fields: secretSauce/);
    assert.throws(() => planGbpSync(LOC, { categories: ["Dentist"] }), /gcid/);
    assert.throws(() => planGbpSync(LOC, { photos: ["http://cdn.test/a.jpg"] }), /https/);
    assert.throws(() => planGbpSync(LOC, {}), /nothing to sync/);
  });
});

describe("authority live GbpClient", () => {
  it("syncProfile executes the plan in order against the right hosts", async () => {
    const f = scriptedFetch([jsonResponse(200, { name: "locations/222" }), jsonResponse(200, { name: "locations/222/attributes" }), jsonResponse(200, { name: "p" })]);
    const client = createLiveGbpClient({ token: "t" }, liveDeps(f.fetchImpl).deps);
    const res = await client.syncProfile(LOC, {
      locationRef: LOC,
      title: "Harbor",
      attributes: [{ name: "has_delivery", values: [false] }],
      posts: [{ topic: "update", title: "x", body: "News" }],
    });
    assert.deepEqual(res, { ok: true });
    assert.equal(f.calls[0].method, "PATCH");
    assert.equal(f.calls[0].url.origin + f.calls[0].url.pathname, "https://mybusinessbusinessinformation.googleapis.com/v1/locations/222");
    assert.equal(f.calls[0].url.searchParams.get("updateMask"), "title");
    assert.equal(f.calls[1].url.pathname, "/v1/locations/222/attributes");
    assert.equal(f.calls[1].url.searchParams.get("attributeMask"), "attributes/has_delivery");
    assert.deepEqual(f.calls[1].body, { name: "locations/222/attributes", attributes: [{ name: "attributes/has_delivery", values: [false] }] });
    assert.equal(f.calls[2].url.href, `${V4}/localPosts`);
  });

  it("replyState reads the moderation state from the review", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { reviewId: "r1", reviewReply: { comment: "x", reviewReplyState: "REJECTED" } }),
      jsonResponse(200, { reviewId: "r2", reviewReply: { comment: "x" } }),
      jsonResponse(200, { reviewId: "r3" }),
    ]);
    const client = createLiveGbpClient({ token: "t" }, liveDeps(f.fetchImpl).deps);
    assert.equal(await client.replyState(LOC, "r1"), "REJECTED");
    assert.equal(await client.replyState(LOC, "r2"), "APPROVED");
    assert.equal(await client.replyState(LOC, "r3"), "PENDING");
    assert.equal(f.calls[0].url.href, `${V4}/reviews/r1`);
  });

  it("updateReply posts the approved text", async () => {
    const f = scriptedFetch([jsonResponse(200, { comment: "ok" })]);
    const client = createLiveGbpClient({ token: "t" }, liveDeps(f.fetchImpl).deps);
    assert.deepEqual(await client.updateReply(LOC, "r9", "Thank you"), { reviewId: "r9" });
    assert.deepEqual(f.calls[0].body, { comment: "Thank you" });
  });

  it("resolveGbpClient: fake without auth, live with auth, honest error for an API key", () => {
    assert.equal(resolveGbpClient({ apiKey: null }).name, "fake-gbp");
    assert.equal(resolveGbpClient({ auth: { token: "t" } }).name, "gbp");
    assert.throws(() => resolveGbpClient({ apiKey: "k" }), /needs OAuth/);
  });
});
