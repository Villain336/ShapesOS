// Phase 15.4 (zernio): the Zernio client and the pure helpers, against the
// labelled FAKE Zernio (lib/zernio/fake.ts — built from the OpenAPI spec
// v1.217.1; NOT Zernio). No database, no network.
// Run: npx tsx --test lib/zernio/__tests__/zernio-client.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ZernioClient, ZernioError } from "../client";
import { FakeZernio, FAKE_ZERNIO_LABEL, fakeResolve } from "../fake";
import { clientForFake, getZernioClient, zernioMode, ZernioNotConfiguredError } from "../config";
import {
  ZERNIO_AD_NETWORKS,
  ZERNIO_SOCIAL_PLATFORMS,
  accountCategory,
  accountProfileId,
  campaignPlatformForAccount,
  isZernioId,
  validateOnlySupported,
} from "../spec";
import { buildCreateAdBody, payloadHash, parseBudgetRequest } from "../ads";
import { allocateIncludedAccounts, billableAccounts, managedAdsCredits, monthKey } from "../metering";
import { normalizeZernioCampaign, toMinorUnits } from "../reports";
import { CALLBACK_PATH, X_REDIRECT_URL_MAX, callbackUrl, signConnectState, verifyConnectState } from "../connect";
import { ZERNIO_ACCOUNT_MONTH_CREDITS, ZERNIO_FREE_ACCOUNTS_PER_WORKSPACE, ZERNIO_MANAGED_ADS_MARGIN, CREDIT_COSTS } from "@/lib/metering/credits";
import { ZERNIO_INCLUDED_ACCOUNTS } from "@/lib/billing/entitlements";

function recorder() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("spec constants (OpenAPI v1.217.1)", () => {
  it("16 posting platforms, 7 ad networks, snapchat closed beta", () => {
    assert.equal(ZERNIO_SOCIAL_PLATFORMS.length, 16);
    assert.equal(ZERNIO_AD_NETWORKS.length, 7);
    assert.deepEqual(ZERNIO_AD_NETWORKS.map((n) => n.key), ["meta", "google", "tiktok", "linkedin", "pinterest", "x", "openai"]);
    const x = ZERNIO_AD_NETWORKS.find((n) => n.key === "x")!;
    assert.equal(x.connect.kind === "oauth" && x.connect.needsPostingAccount, "twitter", "connectAds: X Ads needs an X posting account");
    assert.equal(ZERNIO_AD_NETWORKS.find((n) => n.key === "openai")!.connect.kind, "credentials");
  });

  it("validateOnly is Meta, Google PMax / Demand Gen and OpenAI only (createStandaloneAd)", () => {
    assert.equal(validateOnlySupported("facebook"), true);
    assert.equal(validateOnlySupported("instagram"), true);
    assert.equal(validateOnlySupported("openai"), true);
    assert.equal(validateOnlySupported("google", "pmax"), true);
    assert.equal(validateOnlySupported("google", "demand_gen"), true);
    assert.equal(validateOnlySupported("google", "search"), false);
    for (const p of ["tiktok", "linkedin", "pinterest", "twitter"]) assert.equal(validateOnlySupported(p), false, p);
  });

  it("maps ads accounts to campaign platforms and categories", () => {
    assert.equal(campaignPlatformForAccount("metaads"), "facebook");
    assert.equal(campaignPlatformForAccount("googleads"), "google");
    assert.equal(campaignPlatformForAccount("xads"), "twitter");
    assert.equal(campaignPlatformForAccount("openaiads"), "openai");
    assert.equal(accountCategory("metaads"), "ads");
    assert.equal(accountCategory("whatsapp"), "communication");
    assert.equal(accountCategory("instagram"), "social");
    assert.equal(isZernioId("64f0a1b2c3d4e5f6a7b8c9d0"), true);
    assert.equal(isZernioId("../profiles"), false);
  });

  it("listAccounts example: profileId comes populated (spec example) or as a string", () => {
    // From the spec's listAccounts example + SocialAccount.profileId oneOf.
    assert.equal(accountProfileId({ profileId: { _id: "64f0aaaaaaaaaaaaaaaaaaaa", name: "My Brand", slug: "my-brand" } }), "64f0aaaaaaaaaaaaaaaaaaaa");
    assert.equal(accountProfileId({ profileId: "64f0bbbbbbbbbbbbbbbbbbbb" }), "64f0bbbbbbbbbbbbbbbbbbbb");
  });
});

describe("the FAKE Zernio is labelled and answers the spec's shapes", () => {
  it("labels every response as MOCK and reads X-RateLimit-* headers", async () => {
    const fake = new FakeZernio();
    assert.match(FAKE_ZERNIO_LABEL, /FAKE Zernio \(MOCK\)/);
    const res = await fake.fetch("https://zernio.com/api/v1/profiles", { headers: { Authorization: "Bearer k" } });
    assert.equal(res.headers.get("x-zernio-fake"), "MOCK");
    const client = clientForFake(fake);
    await client.listProfiles();
    assert.ok(client.lastRateLimit && typeof client.lastRateLimit.remaining === "number", "rate limit read from headers, not hard-coded");
    assert.equal(client.lastRateLimit!.limit, 600);
  });

  it("createProfile: 201 → profile (spec example shape); duplicate name → 409 details.existingProfileId; Idempotency-Key replays", async () => {
    const fake = new FakeZernio();
    const c = clientForFake(fake);
    const p = await c.createProfile({ name: "Marketing Team", description: "Profile for marketing campaigns" }, "k1");
    assert.ok(isZernioId(p._id));
    assert.equal(p.name, "Marketing Team");
    const replay = await c.createProfile({ name: "Marketing Team", description: "Profile for marketing campaigns" }, "k1");
    assert.equal(replay._id, p._id, "same key + same body replays the original 201");
    await assert.rejects(
      () => c.createProfile({ name: "Marketing Team" }, "k2"),
      (e: unknown) => e instanceof ZernioError && e.status === 409 && e.zernioCode === "profile_name_conflict" && e.details?.existingProfileId === p._id,
    );
  });

  it("unauthorized → ErrorResponse code missing_credentials / invalid_credentials, key never echoed", async () => {
    const fake = new FakeZernio({ apiKey: "right-key" });
    const c = new ZernioClient({ apiKey: "sk-wrong-secret-key-123", mode: "mock", fetchImpl: fake.fetch, resolve: fakeResolve, sleep: async () => {} });
    await assert.rejects(
      () => c.listProfiles(),
      (e: unknown) => e instanceof ZernioError && e.code === "auth_rejected" && e.zernioCode === "invalid_credentials" && !e.message.includes("sk-wrong-secret-key-123"),
    );
  });

  it("getConnectUrl returns an authUrl for the profile; X refuses a redirect_url over 258 encoded chars", async () => {
    const fake = new FakeZernio();
    const c = clientForFake(fake);
    const p = await c.createProfile({ name: "P" }, "kp");
    const { authUrl } = await c.getConnectUrl("instagram", { profileId: p._id, redirectUrl: "https://app.example/api/zernio/callback?s=abc" });
    const u = new URL(authUrl);
    assert.equal(u.searchParams.get("connected"), "instagram");
    assert.equal(u.searchParams.get("profileId"), p._id);
    assert.ok(isZernioId(u.searchParams.get("accountId")));
    await assert.rejects(
      () => c.getConnectUrl("twitter", { profileId: p._id, redirectUrl: `https://app.example/${"x".repeat(260)}` }),
      (e: unknown) => e instanceof ZernioError && e.zernioCode === "INVALID_REDIRECT_URL",
    );
    await assert.rejects(
      () => c.getConnectUrl("snapchat", { profileId: p._id, redirectUrl: "https://app.example/cb" }),
      (e: unknown) => e instanceof ZernioError && e.status === 403 && e.zernioCode === "PLATFORM_BETA_RESTRICTED",
    );
  });
});

describe("retry policy: Retry-After honoured, writes never repeated blindly", () => {
  it("a read waits Retry-After on 429 then succeeds", async () => {
    const fake = new FakeZernio();
    const r = recorder();
    const c = clientForFake(fake, { sleep: r.sleep });
    fake.failNext("listProfiles", { status: 429, retryAfterSec: 7 });
    await c.listProfiles();
    assert.deepEqual(r.waits, [7000]);
    assert.equal(fake.callsOf("listProfiles").length, 2);
  });

  it("a write retries a 429 ONCE after Retry-After; a second 429 comes back as rate_limited with the seconds", async () => {
    const fake = new FakeZernio();
    const r = recorder();
    const c = clientForFake(fake, { sleep: r.sleep });
    const p = await c.createProfile({ name: "W" }, "kw");
    fake.failNext("createLeadForm", { status: 429, retryAfterSec: 5 });
    fake.failNext("createLeadForm", { status: 429, retryAfterSec: 9 });
    await assert.rejects(
      () => c.createLeadForm({ accountId: "x", name: "n", privacyPolicyUrl: "https://x" }),
      (e: unknown) => e instanceof ZernioError && e.code === "rate_limited" && e.retryAfterSec === 9,
    );
    assert.deepEqual(r.waits, [5000]);
    assert.equal(fake.callsOf("createLeadForm").length, 2, "one retry, never a loop");
    void p;
  });

  it("a Retry-After beyond 60 s is not slept through — it is returned to the caller", async () => {
    const fake = new FakeZernio();
    const r = recorder();
    const c = clientForFake(fake, { sleep: r.sleep });
    fake.failNext("createLeadForm", { status: 429, retryAfterSec: 240 });
    await assert.rejects(
      () => c.createLeadForm({ accountId: "x", name: "n", privacyPolicyUrl: "https://x" }),
      (e: unknown) => e instanceof ZernioError && e.retryAfterSec === 240,
    );
    assert.deepEqual(r.waits, []);
  });

  it("a 5xx on a non-idempotent write is never retried; with an Idempotency-Key it is retried once", async () => {
    const fake = new FakeZernio();
    const c = clientForFake(fake);
    fake.failNext("createAdAudience", { status: 502 });
    await assert.rejects(() => c.createAdAudience({ accountId: "x", name: "n", type: "website" }), (e: unknown) => e instanceof ZernioError && e.status === 502);
    assert.equal(fake.callsOf("createAdAudience").length, 1, "no blind retry of a create");
    const p = await c.createProfile({ name: "I" }, "ki");
    fake.failNext("createProfile", { status: 503 });
    const again = await c.createProfile({ name: "I" }, "ki");
    assert.equal(again._id, p._id);
  });

  it("Meta: at most N creates per ad account per window, validateOnly counted (MetaAdAccountWriteLimited)", async () => {
    let now = 1_000_000;
    const fake = new FakeZernio({ metaCreatesPerWindow: 2, now: () => now });
    const r = recorder();
    const c = clientForFake(fake, { sleep: r.sleep });
    const p = await c.createProfile({ name: "M" }, "km");
    const meta = fake.connectAccount(p._id, "metaads");
    const adAccountId = fake.adAccounts.get(meta._id)![0]!.id;
    const body = { accountId: meta._id, adAccountId, name: "Ad", budgetAmount: 5, budgetType: "daily", status: "PAUSED" };
    await c.validateStandaloneAd(body);
    await c.validateStandaloneAd(body);
    // The window resets in ~5 minutes: longer than a call should sit, so the
    // Retry-After is handed back (the proposal says "try again in N s").
    await assert.rejects(
      () => c.validateStandaloneAd(body),
      (e: unknown) => e instanceof ZernioError && e.code === "rate_limited" && (e.retryAfterSec ?? 0) > 60,
    );
    assert.equal(r.waits.length, 0, "a 5-minute Retry-After is not slept through");
    assert.equal(fake.callsOf("createStandaloneAd").length, 3, "no loop of validations");
    now += 5 * 60 * 1000;
    await c.validateStandaloneAd(body);
  });
});

describe("ad create payload (createStandaloneAd)", () => {
  it("keeps only spec fields, defaults to PAUSED, strips validateOnly, needs a whole-unit budget", () => {
    const body = buildCreateAdBody({
      ad: { accountId: "a", adAccountId: "act_1", name: "Spring", budgetAmount: 50, budgetType: "daily", headline: "h", validateOnly: false, evil: "x" },
    });
    assert.equal(body.status, "PAUSED");
    assert.equal("validateOnly" in body, false);
    assert.equal("evil" in body, false);
    assert.equal(body.budgetAmount, 50);
    assert.throws(() => buildCreateAdBody({ ad: { accountId: "a", adAccountId: "act_1", name: "n" } }), /budgetAmount/);
    assert.throws(() => buildCreateAdBody({ ad: { accountId: "a", adAccountId: "act_1", name: "n", budgetAmount: 5, budgetType: "weekly" } }), /budgetType/);
    assert.equal(buildCreateAdBody({ ad: JSON.stringify({ accountId: "a", adAccountId: "b", name: "c", adSetId: "s" }) }).adSetId, "s");
  });

  it("the payload hash ignores key order (one dry run matches its create)", () => {
    const a = payloadHash({ name: "x", budgetAmount: 5, targeting: { countries: ["US"], ageMin: 18 } });
    const b = payloadHash({ targeting: { ageMin: 18, countries: ["US"] }, budgetAmount: 5, name: "x" });
    assert.equal(a, b);
    assert.notEqual(a, payloadHash({ name: "x", budgetAmount: 6, targeting: { countries: ["US"], ageMin: 18 } }));
  });

  it("budget requests are whole currency units, daily by default", () => {
    assert.deepEqual(parseBudgetRequest({ amount: 8 }), { amount: 8, type: "daily" });
    assert.throws(() => parseBudgetRequest({ amount: -1 }));
    assert.throws(() => parseBudgetRequest({ amount: 5, type: "weekly" }));
  });
});

describe("cost recovery (pure)", () => {
  it("constants: ~600 credits per account-month, 2 free, plan inclusions 3/10/25/50", () => {
    assert.equal(ZERNIO_ACCOUNT_MONTH_CREDITS, 600);
    assert.equal(CREDIT_COSTS.zernio_account_month.credits, ZERNIO_ACCOUNT_MONTH_CREDITS);
    assert.equal(CREDIT_COSTS.zernio_managed_ads.basis, "passthrough");
    assert.equal(ZERNIO_FREE_ACCOUNTS_PER_WORKSPACE, 2);
    assert.deepEqual(
      { starter: ZERNIO_INCLUDED_ACCOUNTS.starter, pro: ZERNIO_INCLUDED_ACCOUNTS.pro, business: ZERNIO_INCLUDED_ACCOUNTS.business, agency: ZERNIO_INCLUDED_ACCOUNTS.agency },
      { starter: 3, pro: 10, business: 25, agency: 50 },
    );
  });

  it("allocates included accounts per plan, pools Agency per owner, keeps the free floor", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    const later = new Date("2026-02-01T00:00:00Z");
    const m = allocateIncludedAccounts([
      { id: "s", plan: "starter", ownerUserId: "u1", createdAt: d, connected: 5 },
      { id: "p", plan: "pro", ownerUserId: "u1", createdAt: d, connected: 12 },
      { id: "t", plan: "trial", ownerUserId: "u1", createdAt: d, connected: 4 },
      { id: "h", plan: "self_hosted", ownerUserId: "u1", createdAt: d, connected: 99 },
      { id: "a1", plan: "agency", ownerUserId: "boss", createdAt: d, connected: 30 },
      { id: "a2", plan: "agency", ownerUserId: "boss", createdAt: later, connected: 30 },
      { id: "a3", plan: "agency", ownerUserId: "other", createdAt: d, connected: 1 },
    ]);
    assert.equal(m.get("s"), 3);
    assert.equal(m.get("p"), 10);
    assert.equal(m.get("t"), 2);
    assert.equal(m.get("h"), null);
    assert.equal(m.get("a1"), 30, "oldest agency workspace draws first from the pool of 50");
    assert.equal(m.get("a2"), 20);
    assert.equal(m.get("a3"), 2, "another owner's pool; free floor");
    assert.equal(billableAccounts(5, 3), 2);
    assert.equal(billableAccounts(99, null), 0);
    assert.equal(billableAccounts(30, 20), 10);
  });

  it("managed-ad overage at cost × margin; month key is UTC", () => {
    assert.equal(managedAdsCredits(0), 0);
    assert.equal(managedAdsCredits(10), Math.ceil(10 * 100 * ZERNIO_MANAGED_ADS_MARGIN));
    assert.equal(monthKey(new Date("2026-10-01T01:00:00Z")), "2026-10");
  });
});

describe("ad insights into ad_reports (getAdTree daily → NormalizedAdRow)", () => {
  it("money in minor units of the campaign's own currency, ctr as a fraction", () => {
    const rows = normalizeZernioCampaign({
      platformCampaignId: "123",
      platform: "facebook",
      currency: "USD",
      daily: [{ date: "2026-10-01", spend: 12.5, impressions: 1000, clicks: 30, ctr: 3, conversions: 1.5, purchaseValue: 40 }],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.spendCents, 1250);
    assert.equal(rows[0]!.revenueCents, 4000);
    assert.equal(rows[0]!.ctr, 0.03);
    assert.equal(rows[0]!.externalCampaignId, "123");
    assert.equal(toMinorUnits(500, "JPY"), 500, "zero-decimal currencies are not multiplied");
  });
});

describe("connect state (the callback is bound to the user who started it)", () => {
  const env = { AUTH_SECRET: "test-secret-for-zernio-state" };
  it("verifies for the same user, refuses another user, a tamper, and expiry", () => {
    const now = Date.parse("2026-10-05T12:00:00Z");
    const s = signConnectState({ workspaceId: "ws_abc", userId: "u1", now }, env);
    assert.equal(verifyConnectState(s, { userId: "u1", now }, env), "ws_abc");
    assert.equal(verifyConnectState(s, { userId: "u2", now }, env), null);
    assert.equal(verifyConnectState(s.replace("ws_abc", "ws_xyz"), { userId: "u1", now }, env), null);
    assert.equal(verifyConnectState(s, { userId: "u1", now: now + 31 * 60 * 1000 }, env), null);
    assert.equal(verifyConnectState("garbage", { userId: "u1", now }, env), null);
  });
  it("the callback URL fits X's 258-character redirect_url limit", () => {
    const s = signConnectState({ workspaceId: "cmabcdefghijklmnopqrstuvw", userId: "u1" }, env);
    const url = callbackUrl("https://marketr.launchabl.com", s);
    assert.ok(url.includes(CALLBACK_PATH));
    assert.ok(encodeURIComponent(url).length <= X_REDIRECT_URL_MAX, `${encodeURIComponent(url).length} chars`);
  });
});

describe("modes: live / labelled mock / off", () => {
  it("the key means live; no key is mock outside production and OFF in production", () => {
    assert.equal(zernioMode({ ZERNIO_API_KEY: "zk" } as unknown as NodeJS.ProcessEnv), "live");
    assert.equal(zernioMode({ NODE_ENV: "development" } as NodeJS.ProcessEnv), "mock");
    assert.equal(zernioMode({ NODE_ENV: "production" } as NodeJS.ProcessEnv), "off");
    assert.equal(zernioMode({ NODE_ENV: "production", ALLOW_FAKE_PROVIDERS: "1" } as NodeJS.ProcessEnv), "mock");
    assert.throws(() => getZernioClient({ NODE_ENV: "production" } as NodeJS.ProcessEnv), (e: unknown) => e instanceof ZernioNotConfiguredError && /not connected/.test((e as Error).message));
    assert.equal(getZernioClient({ NODE_ENV: "development" } as NodeJS.ProcessEnv).mode, "mock");
    assert.equal(getZernioClient({ ZERNIO_API_KEY: "zk", ZERNIO_BASE_URL: "https://zernio.example/api/" } as unknown as NodeJS.ProcessEnv).baseUrl, "https://zernio.example/api");
  });
});
