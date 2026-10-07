// ShapesOS — Phase 18.3 (WS=trust) DB test: the session registry behind the JWT.
//   - a revoked session's token is refused on its next read; the others aren't;
//   - "sign out other sessions" keeps the current one, ends the rest, and cuts
//     off tokens minted before the registry (legacy cutoff);
//   - user_sessions is owner-only (FORCE RLS on app.user_id): another person,
//     or no person GUC at all, sees nothing and can't write a row for someone else;
//   - account deletion removes the rows;
//   - (integration) revoking a session removes the Web Push subscriptions it
//     made; "sign out other sessions" keeps only the current session's.
// Real Postgres as the least-privilege app role.
// Run: DATABASE_URL=<app role> npx tsx --test lib/auth/__tests__/sessions-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const RUN = randomUUID().slice(0, 8);
const ALICE = `sess-alice-${RUN}`;
const BOB = `sess-bob-${RUN}`;
const CARA = `sess-cara-${RUN}`;

let prisma: typeof import("@/lib/prisma").prisma;
let s: typeof import("../sessions");
let reg: typeof import("../session-registry");

const exp = () => new Date(Date.now() + 12 * 3600_000);
const nowSec = () => Math.floor(Date.now() / 1000);

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  s = await import("../sessions");
  reg = await import("../session-registry");
});

after(async () => {
  for (const u of [ALICE, BOB, CARA]) {
    await s.withSessionOwner(u, (tx) => tx.userSession.deleteMany({ where: { userId: u } }));
    await s.withSessionOwner(u, (tx) => tx.pushSubscription.deleteMany({ where: { userId: u } }));
  }
  await prisma.$disconnect();
});

describe("session registry (DB)", () => {
  it("a revoked session ends that token on its next read, and only that one", async () => {
    const laptop = await s.startUserSession({ userId: ALICE, provider: "credentials", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0 Safari/537.36", ip: "203.0.113.9", expiresAt: exp() });
    const phone = await s.startUserSession({ userId: ALICE, provider: "credentials", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1", ip: "198.51.100.7", expiresAt: exp() });
    s.clearSessionCheckCache();
    assert.equal(await s.checkUserSession({ sub: ALICE, sid: laptop, authAt: nowSec() }), "allow");
    assert.equal(await s.checkUserSession({ sub: ALICE, sid: phone, authAt: nowSec() }), "allow");

    const listed = await s.listUserSessions(ALICE, laptop);
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map((x) => x.current).sort(), [false, true]);
    const row = listed.find((x) => x.id === laptop)!;
    assert.equal(row.deviceLabel, "Chrome on macOS");
    assert.equal(row.ipPrefix, "203.0.113.0/24", "IP prefix only");
    assert.ok(!JSON.stringify(listed).includes("203.0.113.9"), "never the full address");

    assert.equal(await s.revokeUserSession(ALICE, phone), true);
    // Another process (no cache): the database answers.
    s.clearSessionCheckCache();
    assert.equal(await s.checkUserSession({ sub: ALICE, sid: phone, authAt: nowSec() }), "reject", "the revoked token is refused");
    assert.equal(await s.checkUserSession({ sub: ALICE, sid: laptop, authAt: nowSec() }), "allow", "the other session is untouched");
    assert.deepEqual((await s.listUserSessions(ALICE, laptop)).map((x) => x.id), [laptop]);
  });

  it("sign out other sessions: keeps this one, ends the rest, and cuts off pre-registry tokens", async () => {
    const keep = await s.startUserSession({ userId: ALICE, expiresAt: exp() });
    const other = await s.startUserSession({ userId: ALICE, expiresAt: exp() });
    const legacyToken = { sub: ALICE, authAt: nowSec() - 3600 };
    s.clearSessionCheckCache();
    assert.equal(await s.checkUserSession(legacyToken), "allow", "a token from before the registry works until the cutoff");
    const n = await s.revokeOtherSessions(ALICE, keep);
    assert.ok(n >= 1);
    s.clearSessionCheckCache();
    assert.equal(await s.checkUserSession({ sub: ALICE, sid: other, authAt: nowSec() }), "reject");
    assert.equal(await s.checkUserSession({ sub: ALICE, sid: keep, authAt: nowSec() }), "allow");
    assert.equal(await s.checkUserSession(legacyToken), "reject", "older tokens without a session row are cut off");
    assert.equal(await s.checkUserSession({ sub: ALICE, authAt: nowSec() + 5 }), "allow", "a legacy token signed in after the cutoff still works");
    assert.ok(!(await s.listUserSessions(ALICE, keep)).some((x) => x.id.startsWith(reg.LEGACY_ROW_PREFIX)), "the cutoff row is never listed");
  });

  it("a missing row (e.g. after account deletion) ends the token", async () => {
    s.clearSessionCheckCache();
    assert.equal(await s.checkUserSession({ sub: ALICE, sid: `nope-${RUN}`, authAt: nowSec() }), "reject");
  });

  it("owner-only: another person sees nothing and can't revoke or write someone else's rows", async () => {
    const mine = await s.startUserSession({ userId: ALICE, expiresAt: exp() });
    // Bob's scope: Alice's rows are invisible, and a revoke matches nothing.
    assert.equal((await s.withSessionOwner(BOB, (tx) => tx.userSession.findMany({ where: { userId: ALICE } }))).length, 0);
    assert.equal(await s.revokeUserSession(BOB, mine), false);
    s.clearSessionCheckCache();
    assert.equal(await s.checkUserSession({ sub: ALICE, sid: mine, authAt: nowSec() }), "allow", "Bob could not revoke it");
    // Bob can't write a row that names Alice (WITH CHECK).
    await assert.rejects(s.withSessionOwner(BOB, (tx) => tx.userSession.create({ data: { userId: ALICE, expiresAt: exp() } })));
    // No person GUC at all: zero rows (fail closed).
    assert.equal(await prisma.userSession.count({ where: { userId: ALICE } }), 0);
    // And Bob's token can't ride on Alice's session id.
    s.clearSessionCheckCache();
    assert.equal(await s.checkUserSession({ sub: BOB, sid: mine, authAt: nowSec() }), "reject");
  });

  it("account deletion's person-only RLS list covers the registry", async () => {
    const { PERSONAL_USER_RLS_TABLES } = await import("@/lib/gdpr/account-delete");
    assert.ok(PERSONAL_USER_RLS_TABLES.some((t) => t.table === "user_sessions"));
    await s.startUserSession({ userId: BOB, expiresAt: exp() });
    await s.withSessionOwner(BOB, (tx) => tx.$executeRawUnsafe(`DELETE FROM "user_sessions" WHERE "user_id" = $1`, BOB));
    assert.equal((await s.withSessionOwner(BOB, (tx) => tx.userSession.findMany({ where: { userId: BOB } }))).length, 0);
  });
  it("revoking a session removes the Web Push subscriptions it made (Phase 18.3 integration)", async () => {
    const { saveWebPushSubscription } = await import("@/lib/push/web");
    const sub = (n: string, sessionId: string | null) =>
      saveWebPushSubscription(CARA, { endpoint: `https://fcm.googleapis.com/fcm/send/${RUN}-${n}`, keys: { p256dh: "BPk", auth: "au" }, sessionId });
    const here = await s.startUserSession({ userId: CARA, expiresAt: exp() });
    const laptop = await s.startUserSession({ userId: CARA, expiresAt: exp() });
    const phone = await s.startUserSession({ userId: CARA, expiresAt: exp() });
    await sub("here", here);
    await sub("laptop", laptop);
    await sub("phone", phone);
    await sub("legacy", null);
    const endpoints = async () =>
      (await s.withSessionOwner(CARA, (tx) => tx.pushSubscription.findMany({ where: { userId: CARA }, select: { endpoint: true } }))).map((r) => r.endpoint.split("-").pop()).sort();
    assert.deepEqual(await endpoints(), ["here", "laptop", "legacy", "phone"]);
    assert.equal(await s.revokeUserSession(CARA, phone), true);
    assert.deepEqual(await endpoints(), ["here", "laptop", "legacy"], "the revoked phone stops getting pushes");
    // Bob can't remove Cara's subscriptions by revoking her session id.
    assert.equal(await s.revokeUserSession(BOB, laptop), false);
    assert.deepEqual(await endpoints(), ["here", "laptop", "legacy"]);
    await s.revokeOtherSessions(CARA, here);
    assert.deepEqual(await endpoints(), ["here"], "only this session's browser keeps Web Push (pre-registry tokens are cut off too)");
  });
});
