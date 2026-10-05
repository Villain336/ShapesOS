// Deploy PR (WS=state): per-process state moved to Postgres, proven across
// two "instances". Run as the least-privilege app role:
//   DATABASE_URL=<app role> npx tsx --test lib/api/__tests__/shared-state-db.test.ts
//
// An "instance" here is an independent store object with no shared memory
// (single-use tokens), or the same limiter called after the per-process
// fallback state has been wiped — which is exactly what a second replica
// looks like: it shares only the database.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { __resetLocalWindows, __setCounterStoreForTests, sharedCounterStore, sharedWindowHit } from "@/lib/api/rate-limit-store";
import { hashToken, postgresSingleUseTokens, sharedSingleUseTokens } from "@/lib/api/single-use-tokens";
import { checkReviewPageRateLimit } from "@/lib/reviews/rate-limit";
import { checkRedeemRateLimit } from "@/lib/physical/bundles";
import { checkRateLimit as checkPixabay } from "@/lib/design/pixabay";
import { mayResendMagicLink } from "@/lib/funding/viewer-verify";
import { claimExportSlot, releaseExportSlot } from "@/lib/gdpr/limit";
import { checkReplay, memoryReplayStore } from "@/lib/substrate/graph/connectors/hmac";
import { confirmDomainPurchase, previewDomainPurchase, saveRegistrant } from "@/lib/studio/service";
import { createMockPorkbunPort } from "@/lib/studio/porkbun";

const RUN = `deploy-ss-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;

/** Wipe what a second replica would not have: every per-process window. */
const otherInstance = () => __resetLocalWindows();

before(async () => {
  __setCounterStoreForTests(undefined); // env selection: Postgres (DATABASE_URL is set)
  assert.equal(sharedCounterStore()?.kind, "postgres", "the shared counter store must be selected");
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.create({ data: { id, name: `deploy ${id}`, ownerUserId: "deploy-owner" } });
  }
});

after(async () => {
  await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: RUN } } });
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("single-use tokens (Postgres, FORCE RLS)", () => {
  it("a token issued by one instance is accepted ONCE by another; replays are refused", async () => {
    const a = postgresSingleUseTokens();
    const b = postgresSingleUseTokens();
    assert.equal(sharedSingleUseTokens().kind, "postgres");
    const token = await a.issue({ workspaceId: WS_A, purpose: "test", payload: { x: 1 }, expiresAt: new Date(Date.now() + 60_000) });
    // Only the hash is stored.
    const rows = await withWorkspaceScope(WS_A, (tx) => tx.singleUseToken.findMany({ where: { workspaceId: WS_A } }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tokenHash, hashToken(token));
    assert.notEqual(rows[0]!.tokenHash, token);

    const first = await b.consume({ workspaceId: WS_A, purpose: "test", token });
    assert.equal(first.status, "ok");
    assert.deepEqual(first.status === "ok" && first.payload, { x: 1 });
    assert.equal((await a.consume({ workspaceId: WS_A, purpose: "test", token })).status, "invalid", "replay on the issuer");
    assert.equal((await b.consume({ workspaceId: WS_A, purpose: "test", token })).status, "invalid", "replay on the consumer");
  });

  it("two instances racing on the same token: exactly one wins", async () => {
    const a = postgresSingleUseTokens();
    const b = postgresSingleUseTokens();
    const token = await a.issue({ workspaceId: WS_A, purpose: "race", payload: {}, expiresAt: new Date(Date.now() + 60_000) });
    const results = await Promise.all([a.consume({ workspaceId: WS_A, purpose: "race", token }), b.consume({ workspaceId: WS_A, purpose: "race", token })]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["invalid", "ok"]);
  });

  it("another workspace, another purpose, garbage and expired tokens are refused", async () => {
    const s = postgresSingleUseTokens();
    const token = await s.issue({ workspaceId: WS_A, purpose: "p1", payload: {}, expiresAt: new Date(Date.now() + 60_000) });
    assert.equal((await s.consume({ workspaceId: WS_B, purpose: "p1", token })).status, "invalid", "RLS: workspace B cannot see A's token");
    assert.equal((await s.consume({ workspaceId: WS_A, purpose: "p2", token })).status, "invalid");
    assert.equal((await s.consume({ workspaceId: WS_A, purpose: "p1", token: "short" })).status, "invalid");
    assert.equal((await s.consume({ workspaceId: WS_A, purpose: "p1", token })).status, "ok", "still valid for its own workspace + purpose");
    const old = await s.issue({ workspaceId: WS_A, purpose: "p1", payload: {}, expiresAt: new Date(Date.now() - 1000) });
    assert.equal((await s.consume({ workspaceId: WS_A, purpose: "p1", token: old })).status, "expired");
    assert.equal((await s.consume({ workspaceId: WS_A, purpose: "p1", token: old })).status, "invalid", "an expired token is consumed too");
    // Without the GUC the app role sees nothing (FORCE RLS).
    assert.equal(await prisma.singleUseToken.count(), 0);
  });

  it("domain purchase: preview on one replica, confirm once on another (no charge on replay)", async () => {
    const project = await prisma.project.create({ data: { workspaceId: WS_A, domain: `${RUN}.example` } });
    const port = createMockPorkbunPort();
    await saveRegistrant(prisma, WS_A, {
      firstName: "T", lastName: "L", email: "t@example.com", phone: "+15551234567",
      address: "1 Main St", city: "Greensboro", state: "NC", zip: "27401", country: "US",
    });
    const preview = await previewDomainPurchase(prisma, WS_A, project.id, port, "myavailabledomain.com");
    const stored = await withWorkspaceScope(WS_A, (tx) => tx.singleUseToken.count({ where: { purpose: "studio_domain_purchase" } }));
    assert.equal(stored, 1, "the confirmation token lives in Postgres, not in this process");
    const done = await confirmDomainPurchase(prisma, WS_A, project.id, port, { confirmationToken: preview.confirmationToken, agreeToTerms: true, whoisPrivacy: true });
    assert.equal(done.domain, "myavailabledomain.com");
    await assert.rejects(
      () => confirmDomainPurchase(prisma, WS_A, project.id, port, { confirmationToken: preview.confirmationToken, agreeToTerms: true, whoisPrivacy: true }),
      /expired or invalid/,
    );
    await assert.rejects(
      () => confirmDomainPurchase(prisma, WS_B, project.id, port, { confirmationToken: preview.confirmationToken, agreeToTerms: true, whoisPrivacy: true }),
      /expired or invalid/,
    );
  });
});

describe("limiters count across instances (shared counter store)", () => {
  it("review landing page: 30/min per token+IP across two instances", async () => {
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (await checkReviewPageRateLimit(`${RUN}-tok`, "1.2.3.4", now)) allowed++;
    otherInstance();
    for (let i = 0; i < 20; i++) if (await checkReviewPageRateLimit(`${RUN}-tok`, "1.2.3.4", now)) allowed++;
    assert.equal(allowed, 30, "the second instance sees the first one's 20 hits");
  });

  it("bundle redeem: 10/min per code+IP across two instances", async () => {
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 6; i++) if (await checkRedeemRateLimit(`${RUN}-code`, "5.6.7.8", now)) allowed++;
    otherInstance();
    for (let i = 0; i < 6; i++) if (await checkRedeemRateLimit(`${RUN}-code`, "5.6.7.8", now)) allowed++;
    assert.equal(allowed, 10);
  });

  it("Pixabay proxy: 100/min per workspace across two instances", async () => {
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 60; i++) if (await checkPixabay(`${RUN}-ws`, now)) allowed++;
    otherInstance();
    for (let i = 0; i < 60; i++) if (await checkPixabay(`${RUN}-ws`, now)) allowed++;
    assert.equal(allowed, 100);
  });

  it("data-room magic link: one email per minute per link+address across instances", async () => {
    const now = Date.now();
    assert.equal(await mayResendMagicLink(`${RUN}-lnk`, "a@b.example", now), true);
    otherInstance();
    assert.equal(await mayResendMagicLink(`${RUN}-lnk`, "A@B.example", now + 1000), false, "case-insensitive, other instance");
    assert.equal(await mayResendMagicLink(`${RUN}-lnk`, "a@b.example", now + 61_000), true);
  });

  it("GDPR export slot: held on one instance is refused on another, until released", async () => {
    const key = `workspace:${RUN}`;
    assert.equal(await claimExportSlot(key), true);
    otherInstance();
    assert.equal(await claimExportSlot(key), false);
    await releaseExportSlot(key);
    otherInstance();
    assert.equal(await claimExportSlot(key), true);
    await releaseExportSlot(key);
  });

  it("webhook replay: a delivery accepted by one instance is refused by another", async () => {
    const body = JSON.stringify({ run: RUN });
    assert.equal((await checkReplay("shopify", body, `${RUN}-delivery-1`, null)).ok, true);
    otherInstance();
    const again = await checkReplay("shopify", body, `${RUN}-delivery-1`, null);
    assert.equal(again.ok, false);
    assert.match(again.ok ? "" : again.reason, /replay/);
    // Concurrent copies of one delivery: exactly one is accepted.
    const both = await Promise.all([checkReplay("meta", body, `${RUN}-delivery-2`, null), checkReplay("meta", body, `${RUN}-delivery-2`, null)]);
    assert.deepEqual(both.map((r) => r.ok).sort(), [false, true]);
    // The injectable in-process store keeps working for callers that pass it.
    assert.equal((await checkReplay("hubspot", body, `${RUN}-delivery-3`, null, memoryReplayStore)).ok, true);
    assert.equal((await checkReplay("hubspot", body, `${RUN}-delivery-3`, null, memoryReplayStore)).ok, false);
  });

  it("a shared window reports where it was counted", async () => {
    const hit = await sharedWindowHit(`${RUN}:probe`, { limit: 1, windowMs: 60_000 });
    assert.equal(hit.source, "shared");
  });
});
