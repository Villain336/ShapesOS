// ShapesOS — Phase 18.3 (WS=flow): Web Push against real Postgres.
//   - push_subscriptions is owner-only FORCE RLS on app.user_id: no GUC =
//     zero rows; another person's GUC sees nothing and can't write theirs
//   - sendWebPush against a STUB push service (labelled: no real FCM/Mozilla
//     here): 201 = sent (encrypted aes128gcm body + vapid Authorization the
//     stub verifies and decrypts); 410/404 = the subscription is deleted at
//     once; 5 failures in a row delete it; other people's rows untouched
//   - without VAPID keys nothing is sent and it says why
//   - account deletion removes the person's subscriptions
// Run (as the least-privilege app role):
//   DATABASE_URL=… npx tsx --test lib/push/__tests__/web-push-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { b64url, decryptAes128gcm, generateVapidKeys, verifyVapidJwt } from "../vapid";
import {
  listWebPushSubscriptions,
  MAX_FAILURES,
  parseSubscription,
  removeWebPushSubscription,
  saveWebPushSubscription,
  sendWebPush,
  withPushUserScope,
  type FetchLike,
} from "../web";
import { accountConfirmationText, deleteAccount } from "@/lib/gdpr/account-delete";

const RUN = randomUUID().slice(0, 8);
const ANA = `p183push-ana-${RUN}`;
const BEN = `p183push-ben-${RUN}`;
const KEYS = generateVapidKeys();
const ENV = { VAPID_PUBLIC_KEY: KEYS.publicKey, VAPID_PRIVATE_KEY: KEYS.privateKey, VAPID_SUBJECT: "mailto:ops@example.test" } as unknown as NodeJS.ProcessEnv;

function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = b64url(Buffer.from(randomUUID().replace(/-/g, "").slice(0, 16)));
  return { ecdh, auth, keys: { p256dh: b64url(ecdh.getPublicKey()), auth } };
}

/** STUB push service (mock, labelled): answers per endpoint with a fixed status. */
function stubPushService(statusFor: (endpoint: string) => number) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: Buffer.from(init.body) });
    return { status: statusFor(url), text: async () => "stub" };
  };
  return { calls, fetchImpl };
}

async function cleanup() {
  for (const u of [ANA, BEN]) await withPushUserScope(u, (tx) => tx.pushSubscription.deleteMany({ where: { userId: u } }));
}

before(cleanup);
after(async () => {
  await cleanup();
  await prisma.userSecurity.deleteMany({ where: { userId: { in: [ANA, BEN] } } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("Web Push (DB)", () => {
  const anaPhone = browser();
  const anaLaptop = browser();
  const benLaptop = browser();
  const EP = (n: string) => `https://fcm.googleapis.com/fcm/send/${RUN}-${n}`;

  it("refuses endpoints that are not a known push service (SSRF guard)", () => {
    assert.equal(parseSubscription({ endpoint: "https://169.254.169.254/latest", keys: anaPhone.keys }).ok, false);
    assert.equal(parseSubscription({ endpoint: "http://fcm.googleapis.com/x", keys: anaPhone.keys }).ok, false);
    assert.equal(parseSubscription({ endpoint: "https://evil.example/fcm.googleapis.com", keys: anaPhone.keys }).ok, false);
    assert.equal(parseSubscription({ endpoint: EP("x"), keys: { p256dh: "AAAA", auth: anaPhone.auth } }).ok, false);
    assert.equal(parseSubscription({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc", keys: anaPhone.keys }).ok, true);
  });

  it("is owner-only under FORCE RLS: no GUC sees nothing; another person can't read or write mine", async () => {
    await saveWebPushSubscription(ANA, { endpoint: EP("ana-phone"), keys: anaPhone.keys });
    await saveWebPushSubscription(ANA, { endpoint: EP("ana-laptop"), keys: anaLaptop.keys });
    await saveWebPushSubscription(BEN, { endpoint: EP("ben-laptop"), keys: benLaptop.keys });
    assert.equal(await prisma.pushSubscription.count({ where: { userId: { in: [ANA, BEN] } } }), 0, "no GUC → zero rows");
    assert.equal((await listWebPushSubscriptions(ANA)).length, 2);
    assert.equal((await listWebPushSubscriptions(BEN)).length, 1);
    const seenByBen = await withPushUserScope(BEN, (tx) => tx.pushSubscription.count({ where: { userId: ANA } }));
    assert.equal(seenByBen, 0, "Ben's GUC can't see Ana's rows");
    await assert.rejects(
      withPushUserScope(BEN, (tx) => tx.pushSubscription.create({ data: { userId: ANA, endpoint: EP("forged"), p256dh: anaPhone.keys.p256dh, authSecret: anaPhone.auth } })),
      /row-level security|violates/i,
      "WITH CHECK refuses a row for someone else",
    );
    assert.equal(await removeWebPushSubscription(BEN, { endpoint: EP("ana-phone") }), 0, "Ben can't remove Ana's");
    // Saving the same browser again refreshes it (no duplicate).
    await saveWebPushSubscription(ANA, { endpoint: EP("ana-phone"), keys: anaPhone.keys });
    assert.equal((await listWebPushSubscriptions(ANA)).length, 2);
  });

  it("without VAPID keys nothing is sent and it says why", async () => {
    const stub = stubPushService(() => 201);
    const r = await sendWebPush(ANA, { title: "Hi" }, { env: {} as NodeJS.ProcessEnv, fetchImpl: stub.fetchImpl });
    assert.equal(r.skipped, "not_configured");
    assert.match(r.reason ?? "", /VAPID_PUBLIC_KEY/);
    assert.equal(stub.calls.length, 0);
  });

  it("sends an encrypted, VAPID-signed push the (stub) push service can verify and the browser can decrypt", async () => {
    const stub = stubPushService(() => 201);
    const r = await sendWebPush(ANA, { title: "Approval needed", body: "Refund #42 waits for you", href: "/dashboard/approvals", kind: "approval_needed" }, { env: ENV, fetchImpl: stub.fetchImpl });
    assert.deepEqual({ sent: r.sent, failed: r.failed, removed: r.removed }, { sent: 2, failed: 0, removed: 0 });
    assert.equal(stub.calls.length, 2, "one POST per subscription, only Ana's");
    const call = stub.calls.find((c) => c.url === EP("ana-phone"))!;
    assert.equal(call.headers["Content-Encoding"], "aes128gcm");
    assert.equal(call.headers.Urgency, "high");
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(call.headers.Authorization!);
    assert.ok(m, "vapid Authorization header");
    const v = verifyVapidJwt(m![1]!, m![2]!);
    assert.equal(v.ok, true);
    assert.equal(v.claims?.aud, "https://fcm.googleapis.com");
    const plain = JSON.parse(decryptAes128gcm(call.body, anaPhone.ecdh.getPrivateKey(), anaPhone.auth).toString("utf8")) as Record<string, unknown>;
    assert.equal(plain.title, "Approval needed");
    assert.equal(plain.href, "/dashboard/approvals");
    const rows = await withPushUserScope(ANA, (tx) => tx.pushSubscription.findMany({ where: { userId: ANA } }));
    assert.ok(rows.every((x) => x.lastSentAt), "last sent recorded");
  });

  it("410/404 from the push service delete that subscription at once; others untouched", async () => {
    const stub = stubPushService((url) => (url === EP("ana-phone") ? 410 : 201));
    const r = await sendWebPush(ANA, { title: "x" }, { env: ENV, fetchImpl: stub.fetchImpl });
    assert.deepEqual({ sent: r.sent, removed: r.removed }, { sent: 1, removed: 1 });
    const left = await listWebPushSubscriptions(ANA);
    assert.equal(left.length, 1);
    assert.equal((await listWebPushSubscriptions(BEN)).length, 1, "Ben's untouched");
    const gone404 = stubPushService(() => 404);
    await sendWebPush(BEN, { title: "x" }, { env: ENV, fetchImpl: gone404.fetchImpl });
    assert.equal((await listWebPushSubscriptions(BEN)).length, 0, "404 also removes");
  });

  it("repeated other failures count up and delete after MAX_FAILURES in a row; a success resets the count", async () => {
    const fail = stubPushService(() => 500);
    for (let i = 1; i < MAX_FAILURES; i++) await sendWebPush(ANA, { title: "x" }, { env: ENV, fetchImpl: fail.fetchImpl });
    let row = (await withPushUserScope(ANA, (tx) => tx.pushSubscription.findFirst({ where: { userId: ANA } })))!;
    assert.equal(row.failureCount, MAX_FAILURES - 1);
    assert.match(row.lastError ?? "", /500/);
    await sendWebPush(ANA, { title: "x" }, { env: ENV, fetchImpl: stubPushService(() => 201).fetchImpl });
    row = (await withPushUserScope(ANA, (tx) => tx.pushSubscription.findFirst({ where: { userId: ANA } })))!;
    assert.equal(row.failureCount, 0, "a success resets");
    for (let i = 0; i < MAX_FAILURES; i++) await sendWebPush(ANA, { title: "x" }, { env: ENV, fetchImpl: fail.fetchImpl });
    assert.equal((await listWebPushSubscriptions(ANA)).length, 0, "deleted after MAX_FAILURES in a row");
    const none = await sendWebPush(ANA, { title: "x" }, { env: ENV, fetchImpl: fail.fetchImpl });
    assert.equal(none.skipped, "no_subscriptions");
  });

  it("account deletion removes the person's subscriptions", async () => {
    await saveWebPushSubscription(BEN, { endpoint: EP("ben-2"), keys: benLaptop.keys });
    assert.equal((await listWebPushSubscriptions(BEN)).length, 1);
    await deleteAccount({ userId: BEN, email: null, confirm: accountConfirmationText(null) });
    assert.equal((await listWebPushSubscriptions(BEN)).length, 0);
  });
});
