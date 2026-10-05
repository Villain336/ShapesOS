// Phase 15.4 (zernio) against real Postgres (FORCE RLS), run as the
// least-privilege app role, with every Zernio call answered by the labelled
// FAKE Zernio (lib/zernio/fake.ts — built from the OpenAPI spec v1.217.1; NOT
// Zernio, so everything here is UNVERIFIED-LIVE until a real key exists):
//   - one profile per workspace, created ONCE under concurrent first uses;
//   - workspace A can never use workspace B's profile, account, ad account or
//     campaign — refused before any HTTP call that touches it, and nothing is
//     ever written for B;
//   - the connect callback records an account for the right workspace only;
//   - ads through the chat connector gate: the validateOnly dry run precedes
//     the create (shown with the proposal, consumed by exactly one create), a
//     failed dry run is never proposed and never creates, Tier 3 (create,
//     resume, budget raise) still asks with a forced auto rule, Tier 2 (pause,
//     a live-proven budget cut) runs under a rule;
//   - social posts go through the one social service (approve → dispatch →
//     refresh) with Zernio as the publisher;
//   - monthly account metering is idempotent and plan-inclusion aware.
// Run: DATABASE_URL=<app role> MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/zernio/__tests__/zernio-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { FakeZernio } from "../fake";
import { clientForFake, setZernioClientForTests } from "../config";
import {
  ZernioScopeError,
  getZernioScope,
  mirroredAccount,
  recordConnectedAccount,
  requireOwnedAccount,
  syncZernioAccounts,
} from "../tenancy";
import { completeConnect, signConnectState, startConnect, verifyConnectState } from "../connect";
import { createAd, dryRunCreateAd } from "../ads";
import { runZernioAccountMetering } from "../metering";
import { syncZernioAdReports } from "../reports";
import { resolveConnectorTool } from "@/lib/chat/connector-tools";
import { ZernioSocialProvider } from "@/lib/social/zernio";
import { createPost, decidePost, refreshStatuses, submitForApproval } from "@/lib/social/publications";
import { ZERNIO_ACCOUNT_MONTH_CREDITS } from "@/lib/metering/credits";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");
process.env.AUTH_SECRET ||= "zernio-db-test-secret";

const RUN = `p154z-${Date.now().toString(36)}`;
const A = `${RUN}-a`;
const B = `${RUN}-b`;
const OWNER = `${RUN}-owner`;
const EDITOR = `${RUN}-editor`;
const OWNER_B = `${RUN}-owner-b`;
const ALL_WS: string[] = [A, B];

const fake = new FakeZernio();
const client = clientForFake(fake);

async function mkWorkspace(id: string, owner: string, plan: "starter" | "pro" | "trial" | "self_hosted" | "agency", createdAt?: Date) {
  await prisma.workspace.create({
    data: { id, name: id, ownerUserId: owner, plan, ...(plan === "trial" ? { trialEndsAt: new Date(Date.now() + 7 * 86_400_000) } : {}), ...(createdAt ? { createdAt } : {}) },
  });
  await prisma.workspaceMember.create({ data: { workspaceId: id, userId: owner, role: "owner" } });
  if (!ALL_WS.includes(id)) ALL_WS.push(id);
}

let projectA = "";
let bAccounts: { social: string; ads: string; adAccount: string; campaign: string } = { social: "", ads: "", adAccount: "", campaign: "" };

before(async () => {
  setZernioClientForTests(client);
  await mkWorkspace(A, OWNER, "starter");
  await prisma.workspaceMember.create({ data: { workspaceId: A, userId: EDITOR, role: "editor" } });
  await mkWorkspace(B, OWNER_B, "pro");
  projectA = (await prisma.project.create({ data: { workspaceId: A, domain: `${RUN}.example` } })).id;
});

after(async () => {
  setZernioClientForTests(null);
  for (const id of ALL_WS) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("one Zernio profile per workspace", () => {
  it("concurrent first uses create exactly ONE profile (one createProfile call, one row)", async () => {
    const scopes = await Promise.all(Array.from({ length: 6 }, () => getZernioScope(A, { userId: OWNER })));
    assert.equal(new Set(scopes.map((s) => s.profileId)).size, 1);
    assert.equal(fake.callsOf("createProfile").length, 1, "the advisory lock serialised the first uses");
    assert.equal(await withWorkspaceScope(A, (tx) => tx.zernioProfile.count({ where: { workspaceId: A } })), 1);
    // The connection the agent's project bindings use: one, no credential.
    const conns = await prisma.connectorConnection.findMany({ where: { workspaceId: A, connectorKey: "zernio" } });
    assert.equal(conns.length, 1);
    assert.equal(await prisma.connectorCredential.count({ where: { connectionId: conns[0]!.id } }), 0, "the platform key is never stored per workspace");
  });

  it("B gets its own profile; profiles are FORCE RLS (A cannot read B's row, no scope sees none)", async () => {
    const a = await getZernioScope(A);
    const b = await getZernioScope(B, { userId: OWNER_B });
    assert.notEqual(a.profileId, b.profileId);
    assert.equal(await withWorkspaceScope(A, (tx) => tx.zernioProfile.count({ where: { workspaceId: B } })), 0);
    assert.equal(await prisma.zernioProfile.count({ where: { workspaceId: { in: [A, B] } } }), 0, "no GUC → zero rows");
    await assert.rejects(withWorkspaceScope(A, (tx) => tx.zernioProfile.create({ data: { workspaceId: B, mode: "live", profileId: "x", name: "x" } })));
  });

  it("a name already taken on the team (409 existingProfileId) is adopted, not duplicated", async () => {
    const C = `${RUN}-c`;
    await mkWorkspace(C, OWNER, "starter");
    await client.createProfile({ name: `ShapesOS workspace ${C}` }, "someone-else");
    const before = fake.profiles.size;
    const s = await getZernioScope(C);
    assert.equal(fake.profiles.size, before, "no second profile");
    assert.equal(fake.profiles.get(s.profileId)?.name, `ShapesOS workspace ${C}`);
  });
});

describe("connect: the callback records accounts for the right workspace only", () => {
  it("A's connect flow → A's account recorded on A only", async () => {
    const scope = await getZernioScope(A);
    const start = await startConnect(scope, { kind: "social", platform: "instagram", origin: "https://app.example", userId: OWNER });
    assert.equal(start.kind, "redirect");
    const back = new URL((start as { authUrl: string }).authUrl);
    // The state on the redirect is bound to A and to the user who started it.
    assert.equal(verifyConnectState(back.searchParams.get("s"), { userId: OWNER }), A);
    assert.equal(verifyConnectState(back.searchParams.get("s"), { userId: OWNER_B }), null);
    const out = await completeConnect(scope, Object.fromEntries(back.searchParams.entries()));
    assert.equal(out.ok, true, out.message);
    assert.equal(out.account?.platform, "instagram");
    assert.ok(await mirroredAccount(scope, out.account!.accountId));
    const bScope = await getZernioScope(B);
    assert.equal(await mirroredAccount(bScope, out.account!.accountId), null);
  });

  it("a crafted callback naming B's account (or B's profile) records nothing for A", async () => {
    const bScope = await getZernioScope(B);
    const bSocial = fake.connectAccount(bScope.profileId, "linkedin", { username: "b-linkedin" });
    await recordConnectedAccount(bScope, bSocial._id);
    const aScope = await getZernioScope(A);
    await assert.rejects(completeConnect(aScope, { connected: "linkedin", accountId: bSocial._id }), (e: unknown) => e instanceof ZernioScopeError);
    const crafted = await completeConnect(aScope, { connected: "linkedin", profileId: bScope.profileId, accountId: bSocial._id });
    assert.equal(crafted.ok, false);
    assert.equal(await mirroredAccount(aScope, bSocial._id), null);
    // An error redirect is reported, never recorded.
    const denied = await completeConnect(aScope, { error: "oauth_denied", platform: "tiktok", error_message: "User cancelled" });
    assert.equal(denied.ok, false);
    assert.match(denied.message, /User cancelled/);
  });
});

describe("ads isolation: A can never act on B's account, ad account or campaign", () => {
  before(async () => {
    const bScope = await getZernioScope(B);
    const ads = fake.connectAccount(bScope.profileId, "metaads");
    await recordConnectedAccount(bScope, ads._id);
    const adAccount = fake.adAccounts.get(ads._id)![0]!.id;
    const campaign = fake.seedCampaign({ accountId: ads._id, adAccountId: adAccount, name: "B spring", budget: { amount: 40, type: "daily" } });
    bAccounts = { social: "", ads: ads._id, adAccount, campaign: campaign.platformCampaignId };
    const aScope = await getZernioScope(A);
    const aAds = fake.connectAccount(aScope.profileId, "metaads");
    await recordConnectedAccount(aScope, aAds._id);
  });

  it("B's account id is refused from A's mirror with ZERO Zernio calls", async () => {
    const aScope = await getZernioScope(A);
    const n = fake.calls.length;
    await assert.rejects(requireOwnedAccount(aScope, bAccounts.ads), (e: unknown) => e instanceof ZernioScopeError && /not connected to this workspace/.test((e as Error).message));
    await assert.rejects(dryRunCreateAd(aScope, { ad: { accountId: bAccounts.ads, adAccountId: bAccounts.adAccount, name: "x", budgetAmount: 5, budgetType: "daily" } }), ZernioScopeError);
    assert.equal(fake.calls.length, n, "refused before any HTTP call");
  });

  it("B's ad account under A's own ads account is refused — no dry run, no create", async () => {
    const aScope = await getZernioScope(A);
    const aAds = (await syncZernioAccounts(aScope)).find((x) => x.platform === "metaads")!;
    const before = fake.callsOf("createStandaloneAd").length;
    await assert.rejects(
      createAd(aScope, { ad: { accountId: aAds.accountId, adAccountId: bAccounts.adAccount, name: "x", budgetAmount: 5, budgetType: "daily" } }),
      (e: unknown) => e instanceof ZernioScopeError && /not under this workspace/.test((e as Error).message),
    );
    assert.equal(fake.callsOf("createStandaloneAd").length, before);
  });

  it("B's campaign: pause / resume / budget / insights through A's agent are refused and nothing is written", async () => {
    const conn = await prisma.connectorConnection.findFirstOrThrow({ where: { workspaceId: A, connectorKey: "zernio" } });
    await prisma.projectDataSource.upsert({
      where: { projectId_connectionId: { projectId: projectA, connectionId: conn.id } },
      create: { projectId: projectA, connectionId: conn.id, connectorKey: "zernio" },
      update: {},
    });
    const ctx = { projectId: projectA, workspaceId: A, userId: OWNER, role: "owner" as const, confirmed: true, agentKey: "lead" as const };
    const writesBefore = fake.calls.filter((c) => c.method !== "GET").length;
    for (const tool of ["ads_pause", "ads_resume", "ads_update_budget", "ads_insights"]) {
      const out = await resolveConnectorTool(`connector.zernio.${tool}`, ctx, { campaignId: bAccounts.campaign, amount: 1 });
      assert.equal(out.status, "error", tool);
      assert.match(out.resultSummary, /not on this workspace's Zernio profile/, tool);
    }
    assert.equal(fake.calls.filter((c) => c.method !== "GET").length, writesBefore, "no write reached Zernio");
    assert.equal(fake.campaigns.get(bAccounts.campaign)!.status, "active");
    assert.deepEqual(fake.campaigns.get(bAccounts.campaign)!.budget, { amount: 40, type: "daily" });
  });
});

describe("ads through the chat connector gate (money law)", () => {
  let aAds = "";
  let aAdAccount = "";
  let aCampaign = "";
  const ctx = (confirmed: boolean) => ({ projectId: projectA, workspaceId: A, userId: OWNER, role: "owner" as const, confirmed, agentKey: "lead" as const });
  const ad = () => ({ accountId: aAds, adAccountId: aAdAccount, name: `${RUN} spring`, goal: "traffic", budgetAmount: 25, budgetType: "daily", headline: "Spring", body: "Come in", linkUrl: "https://shop.example", callToAction: "SHOP_NOW", imageUrl: "https://shop.example/a.jpg" });

  before(async () => {
    const aScope = await getZernioScope(A);
    aAds = (await syncZernioAccounts(aScope)).find((x) => x.platform === "metaads")!.accountId;
    aAdAccount = fake.adAccounts.get(aAds)![0]!.id;
    aCampaign = fake.seedCampaign({ accountId: aAds, adAccountId: aAdAccount, name: "A summer", budget: { amount: 30, type: "daily" } }).platformCampaignId;
    // Forced "auto" rules stored directly (the settings API refuses auto for Tier 3).
    await withWorkspaceScope(A, async (tx) => {
      for (const action of ["buy_media", "resume_ad_campaign", "update_campaign_budget", "lower_campaign_budget", "pause_ad_campaign"]) {
        await tx.automationSetting.create({ data: { workspaceId: A, agentKey: "*", action, behavior: "auto", updatedBy: OWNER } });
      }
    });
  });

  it("ads_create: the dry run runs BEFORE the person is asked and is shown with the proposal; a forced auto rule still asks", async () => {
    const before = fake.callsOf("createStandaloneAd").length;
    const out = await resolveConnectorTool("connector.zernio.ads_create", ctx(false), { ad: ad() });
    assert.equal(out.status, "pending_confirmation", out.resultSummary);
    assert.equal(out.autoAction, undefined, "Tier 3 is never offered 'do this without asking'");
    assert.match(out.resultSummary, /Dry run passed on facebook/);
    assert.match(out.resultSummary, /PAUSED/);
    const calls = fake.callsOf("createStandaloneAd").slice(before);
    assert.equal(calls.length, 1);
    assert.equal((calls[0]!.body as { validateOnly?: boolean }).validateOnly, true, "only the dry run so far");
  });

  it("confirmed: exactly one real create, with no second validation, and the receipt is consumed", async () => {
    const before = fake.callsOf("createStandaloneAd").length;
    const out = await resolveConnectorTool("connector.zernio.ads_create", ctx(true), { ad: ad() });
    assert.equal(out.status, "executed", out.resultSummary);
    const calls = fake.callsOf("createStandaloneAd").slice(before);
    assert.equal(calls.length, 1, "one validation per real create (Meta counts validateOnly as a write)");
    assert.equal((calls[0]!.body as { validateOnly?: boolean }).validateOnly, undefined);
    assert.equal((calls[0]!.body as { status?: string }).status, "PAUSED");
    assert.ok(calls[0]!.idempotencyKey?.startsWith("shapesos-ad-"), "the create carries an Idempotency-Key");
    const receipts = await withWorkspaceScope(A, (tx) => tx.zernioAdValidation.findMany({ where: { workspaceId: A } }));
    assert.equal(receipts.length, 1);
    assert.ok(receipts[0]!.consumedAt, "consumed by that create");
    // Confirming the same ad again does not reuse the receipt: it dry-runs first again.
    const again = fake.callsOf("createStandaloneAd").length;
    await resolveConnectorTool("connector.zernio.ads_create", ctx(true), { ad: ad() });
    const next = fake.callsOf("createStandaloneAd").slice(again);
    assert.equal((next[0]!.body as { validateOnly?: boolean }).validateOnly, true, "validateOnly precedes every create");
    assert.equal(next.length, 2);
  });

  it("a failed dry run is never proposed, and a confirmed call with it never creates", async () => {
    fake.validateFailure = () => ({ error: "Invalid parameter: image too small", type: "platform_error", code: "platform_api_error", platform: "meta" });
    try {
      const before = fake.callsOf("createStandaloneAd").length;
      const bad = { ...ad(), name: `${RUN} bad` };
      const proposed = await resolveConnectorTool("connector.zernio.ads_create", ctx(false), { ad: bad });
      assert.equal(proposed.status, "error");
      assert.match(proposed.resultSummary, /was not proposed: The dry run failed/);
      const forced = await resolveConnectorTool("connector.zernio.ads_create", ctx(true), { ad: bad });
      assert.equal(forced.status, "error");
      const calls = fake.callsOf("createStandaloneAd").slice(before);
      assert.ok(calls.every((c) => (c.body as { validateOnly?: boolean }).validateOnly === true), "nothing but dry runs");
    } finally {
      fake.validateFailure = null;
    }
  });

  it("a platform without a dry run (TikTok → 501) is proposed with that said plainly", async () => {
    const aScope = await getZernioScope(A);
    const tt = fake.connectAccount(aScope.profileId, "tiktokads");
    await recordConnectedAccount(aScope, tt._id);
    const out = await resolveConnectorTool("connector.zernio.ads_create", ctx(false), {
      ad: { accountId: tt._id, adAccountId: fake.adAccounts.get(tt._id)![0]!.id, name: `${RUN} tt`, budgetAmount: 20, budgetType: "daily", imageUrl: "https://v.example/a.mp4" },
    });
    assert.equal(out.status, "pending_confirmation");
    assert.match(out.resultSummary, /cannot dry-run ads on tiktok/);
  });

  it("budget: a live-proven cut runs under its rule (Tier 2); a raise asks even with a forced rule (Tier 3)", async () => {
    const lower = await resolveConnectorTool("connector.zernio.ads_update_budget", ctx(false), { campaignId: aCampaign, amount: 10, type: "daily" });
    assert.equal(lower.status, "executed", lower.resultSummary);
    assert.deepEqual(fake.campaigns.get(aCampaign)!.budget, { amount: 10, type: "daily" });
    assert.ok(fake.callsOf("getAdAccountLiveEntities").length >= 1, "the current budget was read live, not taken from the model");
    const raise = await resolveConnectorTool("connector.zernio.ads_update_budget", ctx(false), { campaignId: aCampaign, amount: 500, type: "daily" });
    assert.equal(raise.status, "pending_confirmation");
    assert.match(raise.resultSummary, /raises the daily budget from 10 to 500/);
    assert.deepEqual(fake.campaigns.get(aCampaign)!.budget, { amount: 10, type: "daily" }, "nothing changed until a person confirms");
    const typeChange = await resolveConnectorTool("connector.zernio.ads_update_budget", ctx(false), { campaignId: aCampaign, amount: 5, type: "lifetime" });
    assert.equal(typeChange.status, "pending_confirmation", "a budget-type change counts as a raise");
  });

  it("pause runs under its rule (Tier 2); resume asks even with a forced rule (Tier 3)", async () => {
    const pause = await resolveConnectorTool("connector.zernio.ads_pause", ctx(false), { campaignId: aCampaign });
    assert.equal(pause.status, "executed", pause.resultSummary);
    assert.equal(fake.campaigns.get(aCampaign)!.status, "paused");
    const resume = await resolveConnectorTool("connector.zernio.ads_resume", ctx(false), { campaignId: aCampaign });
    assert.equal(resume.status, "pending_confirmation");
    assert.equal(fake.campaigns.get(aCampaign)!.status, "paused");
    const confirmed = await resolveConnectorTool("connector.zernio.ads_resume", ctx(true), { campaignId: aCampaign });
    assert.equal(confirmed.status, "executed");
    assert.equal(fake.campaigns.get(aCampaign)!.status, "active");
  });

  it("reads run without asking and are labelled mock on the fake", async () => {
    const out = await resolveConnectorTool("connector.zernio.ads_campaigns", ctx(false), {});
    assert.equal(out.status, "executed");
    assert.match(out.resultSummary, /\(MOCK\)/);
    assert.doesNotMatch(out.resultSummary, /B spring/, "only A's campaigns");
  });

  it("insights feed the existing ad reports (ad_reports, platform zernio) — A's campaigns only", async () => {
    const aScope = await getZernioScope(A);
    const r = await syncZernioAdReports(aScope, { fromDate: "2026-10-01", toDate: "2026-10-03" });
    assert.ok(r.campaigns >= 1 && r.upserted >= 3, JSON.stringify(r));
    const rows = await prisma.adReport.findMany({ where: { workspaceId: A }, include: { campaign: true } });
    assert.ok(rows.length >= 3);
    assert.ok(rows.every((x) => x.campaign.platformKey === "zernio"));
    assert.equal(await prisma.paidAdCampaign.count({ where: { workspaceId: A, externalId: bAccounts.campaign } }), 0);
    const again = await syncZernioAdReports(aScope, { fromDate: "2026-10-01", toDate: "2026-10-03" });
    assert.equal(await prisma.adReport.count({ where: { workspaceId: A } }), rows.length, `idempotent (${again.upserted} upserts)`);
  });
});

describe("social: Zernio publishes through the one social service", () => {
  it("channels are A's posting accounts only; approve → dispatch → refresh → published", async () => {
    const provider = new ZernioSocialProvider(A, { client });
    // A text post: LinkedIn (Instagram needs an image or video).
    fake.connectAccount((await getZernioScope(A)).profileId, "linkedin", { username: "a-linkedin" });
    const channels = await provider.listChannels();
    assert.ok(channels.length >= 2);
    assert.ok(channels.every((c) => !["metaads", "tiktokads"].includes(c.identifier)), "ads accounts are not posting channels");
    const linkedin = channels.filter((c) => c.identifier === "linkedin");
    assert.equal(linkedin.length, 1, "only A's LinkedIn (B's is on B's profile)");
    const post = await createPost(A, OWNER, {
      content: "Spring is here",
      link: "https://shop.example/spring",
      utmCampaign: "Spring",
      channels: linkedin.map((c) => ({ id: c.id, identifier: c.identifier, name: c.name })),
      publishMode: "now",
    });
    await submitForApproval(A, post.id, OWNER);
    const decided = await decidePost(A, post.id, { userId: EDITOR, role: "editor", hasOtherApprover: true }, "approve", null, provider);
    assert.equal(decided.status, "scheduled", decided.error ?? "");
    const created = fake.callsOf("createPost").at(-1)!;
    const body = created.body as { platforms: Array<{ accountId: string; platform: string }>; content: string; publishNow?: boolean };
    assert.equal(body.platforms[0]!.accountId, linkedin[0]!.id);
    assert.match(body.content, /utm_source=/, "the social service's per-channel UTM body");
    assert.ok(created.idempotencyKey, "Idempotency-Key per channel");
    const r = await refreshStatuses(A, provider, new Date(Date.now() + 1000));
    assert.equal(r.published, 1);
  });

  it("a post to B's account is refused before it is sent", async () => {
    const provider = new ZernioSocialProvider(A, { client });
    const bScope = await getZernioScope(B);
    const bChannel = fake.connectAccount(bScope.profileId, "twitter");
    const n = fake.callsOf("createPost").length;
    await assert.rejects(
      provider.createPosts({ type: "now", posts: [{ channel: { id: bChannel._id, identifier: "twitter" }, body: "hi" }], media: [] }),
      /not connected to this workspace's Zernio profile/,
    );
    assert.equal(fake.callsOf("createPost").length, n);
  });
});

describe("monthly account metering", () => {
  it("is plan-inclusion aware (starter includes 3) and idempotent per workspace + month", async () => {
    const S = `${RUN}-meter`;
    await mkWorkspace(S, OWNER, "starter");
    const scope = await getZernioScope(S);
    for (const p of ["instagram", "facebook", "linkedin", "tiktok", "youtube"]) fake.connectAccount(scope.profileId, p);
    fake.managedAdsUsd.set(scope.profileId, 4);
    const now = new Date("2026-11-01T02:30:00Z");
    const first = await runZernioAccountMetering({ client, now, workspaceIds: [S] });
    const row = first.results.find((r) => r.workspaceId === S)!;
    assert.equal(row.status, "charged", row.detail);
    assert.equal(row.connected, 5);
    assert.equal(row.included, 3);
    assert.equal(row.billable, 2);
    assert.equal(row.accountCredits, 2 * ZERNIO_ACCOUNT_MONTH_CREDITS);
    assert.equal(row.managedAdsCredits, 500, "$4 × 1.25 margin");
    const events = () => prisma.usageEvent.findMany({ where: { workspaceId: S, action: { in: ["zernio_account_month", "zernio_managed_ads"] } } });
    const charged = await events();
    assert.deepEqual(charged.map((e) => e.credits).sort((a, b) => a - b), [500, 1200]);
    const second = await runZernioAccountMetering({ client, now, workspaceIds: [S] });
    assert.equal(second.results.find((r) => r.workspaceId === S)!.status, "already_done");
    assert.equal((await events()).length, 2, "never charged twice");
    const snap = await withWorkspaceScope(S, (tx) => tx.zernioAccountUsage.findMany({ where: { workspaceId: S } }));
    assert.equal(snap.length, 1);
    assert.equal(snap[0]!.month, "2026-11");
  });

  it("trial includes the 2 free; self-hosted (own key) charges nothing; Agency pools 50 across the owner's workspaces", async () => {
    const T = `${RUN}-trial`;
    const H = `${RUN}-self`;
    const AG1 = `${RUN}-ag1`;
    const AG2 = `${RUN}-ag2`;
    const AGENCY_OWNER = `${RUN}-agency-owner`;
    await mkWorkspace(T, OWNER, "trial");
    await mkWorkspace(H, OWNER, "self_hosted");
    await mkWorkspace(AG1, AGENCY_OWNER, "agency", new Date("2026-01-01T00:00:00Z"));
    await mkWorkspace(AG2, AGENCY_OWNER, "agency", new Date("2026-02-01T00:00:00Z"));
    const connect = async (ws: string, n: number) => {
      const s = await getZernioScope(ws);
      for (let i = 0; i < n; i++) fake.connectAccount(s.profileId, i % 2 ? "instagram" : "linkedin");
    };
    await connect(T, 2);
    await connect(H, 7);
    await connect(AG1, 30);
    await connect(AG2, 30);
    const now = new Date("2026-11-01T02:30:00Z");
    const out = await runZernioAccountMetering({ client, now, workspaceIds: [T, H, AG1, AG2] });
    const by = (id: string) => out.results.find((r) => r.workspaceId === id)!;
    if (process.env.ZDEBUG) console.log(JSON.stringify(out.results, null, 1));
    assert.equal(by(T).status, "included");
    assert.equal(by(T).billable, 0);
    assert.equal(by(H).status, "included");
    assert.equal(by(H).included, null, "self-hosted: every account is included");
    assert.equal(by(AG1).billable, 0, "oldest agency workspace: 30 of the pool of 50");
    assert.equal(by(AG2).billable, 10, "second: the remaining 20 of the pool");
    assert.equal(by(AG2).accountCredits, 10 * ZERNIO_ACCOUNT_MONTH_CREDITS);
  });
});

describe("connect state is signed per user (route-level check)", () => {
  it("a state signed for A's owner never verifies for B's owner", () => {
    const s = signConnectState({ workspaceId: A, userId: OWNER });
    assert.equal(verifyConnectState(s, { userId: OWNER }), A);
    assert.equal(verifyConnectState(s, { userId: OWNER_B }), null);
  });
});
