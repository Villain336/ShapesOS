// ShapesOS — mobile push devices + delivery (Phase 4b), against a real database.
//   - registration through the route: own devices only, re-register keeps the
//     opt-out, a token moving to another member resets it, per-user cap
//   - opt-out (enabled=false) and per-kind mutes are honored by delivery
//   - DeviceNotRegistered tickets prune the device; repeated errors prune too
//   - push_devices is FORCE RLS (invisible without the workspace scope)
// The Expo push API is mocked (fetchImpl); nothing leaves the box.
// DB-backed (scripts/test/db-tests.txt); run as the least-privilege app role.
// Run: DATABASE_URL=… npx tsx --test --experimental-test-module-mocks lib/push/__tests__/push-devices-db.test.ts

import "dotenv/config";
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { NotificationInput } from "@/lib/notifications/store";
import { MAX_DEVICES_PER_USER, registerDevice } from "../devices";
import { MAX_CONSECUTIVE_FAILURES, pushNotifications } from "../notify";
import { EXPO_PUSH_SEND_URL } from "../expo";

const tag = randomUUID().slice(0, 8);
const WS = `push-ws-${tag}`;
const ALICE = `push-alice-${tag}`;
const BOB = `push-bob-${tag}`;
let actor = { id: ALICE, email: "alice@push.test" };

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
    getOrCreateWorkspace: async () => ({ id: WS, name: WS }),
  },
});

type Route = typeof import("@/app/api/mobile/push-devices/route");
let route: Route;

const tok = (s: string) => `ExponentPushToken[${s}-${tag}]`;
const req = (method: string, body?: unknown) =>
  new Request("http://x/api/mobile/push-devices", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never;
const devices = () => withWorkspaceScope(WS, (tx) => tx.pushDevice.findMany({ where: { workspaceId: WS }, orderBy: { createdAt: "asc" } }));

const ENV = { PUSH_PROVIDER: "expo", EXPO_ACCESS_TOKEN: "test-access-token" } as unknown as NodeJS.ProcessEnv;

function note(userId: string, kind: NotificationInput["kind"], id = randomUUID()): NotificationInput {
  return {
    workspaceId: WS,
    userId,
    kind,
    title: "Messaging needs your approval",
    body: "Reply to Ada",
    href: "/dashboard/approvals?source=messaging",
    sourceType: "messaging",
    sourceId: id,
    dedupKey: `${kind}:${id}`,
  };
}

/** Mock Expo: answers per-token tickets from `byToken` (default ok). */
function expoMock(byToken: Record<string, { status: "error"; error: string }> = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Array<{ to: string; title: string; data: Record<string, unknown> }> }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Array<{ to: string; title: string; data: Record<string, unknown> }>;
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    const data = body.map((m, i) => {
      const e = byToken[m.to];
      return e
        ? { status: "error", message: `"${m.to}" failed`, details: { error: e.error } }
        : { status: "ok", id: `ticket-${i}` };
    });
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

before(async () => {
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
    VALUES (${WS}, ${WS}, ${"test:" + WS}, now()) ON CONFLICT DO NOTHING`;
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: ALICE, role: "viewer", email: "alice@push.test" } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: BOB, role: "editor", email: "bob@push.test" } });
  route = await import("@/app/api/mobile/push-devices/route");
});

beforeEach(async () => {
  await withWorkspaceScope(WS, (tx) => tx.pushDevice.deleteMany({ where: { workspaceId: WS } }));
  actor = { id: ALICE, email: "alice@push.test" };
});

after(async () => {
  await withWorkspaceScope(WS, (tx) => tx.pushDevice.deleteMany({ where: { workspaceId: WS } })).catch(() => {});
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`.catch(() => {});
  await prisma.$disconnect();
});

describe("push device routes", () => {
  it("registers, lists without the raw token, opts out, and removes the caller's own device", async () => {
    const res = await route.POST(req("POST", { token: tok("alice1"), platform: "ios", deviceName: "Alice's iPhone" }));
    assert.equal(res.status, 201);
    const { device } = (await res.json()) as { device: { tokenHint: string; enabled: boolean } };
    assert.equal(device.enabled, true);
    assert.equal(device.tokenHint, `1-${tag}`.slice(-6));

    const listed = (await (await route.GET()).json()) as { devices: Array<Record<string, unknown>>; kinds: string[] };
    assert.equal(listed.devices.length, 1);
    assert.ok(!JSON.stringify(listed).includes("ExponentPushToken"), "the raw token is never returned");
    assert.deepEqual(listed.kinds, ["approval_needed", "approval_decided", "run_failed"]);

    const off = await route.PATCH(req("PATCH", { token: tok("alice1"), enabled: false, mutedKinds: ["run_failed"] }));
    assert.equal(off.status, 200);
    // Re-registering on the next app start keeps the opt-out.
    await route.POST(req("POST", { token: tok("alice1"), platform: "ios" }));
    const [row] = await devices();
    assert.equal(row!.enabled, false);
    assert.deepEqual(row!.mutedKinds, ["run_failed"]);

    // Bob can't change or remove Alice's device.
    actor = { id: BOB, email: "bob@push.test" };
    assert.equal((await route.PATCH(req("PATCH", { token: tok("alice1"), enabled: true }))).status, 404);
    const del = (await (await route.DELETE(req("DELETE", { token: tok("alice1") }))).json()) as { removed: number };
    assert.equal(del.removed, 0);

    actor = { id: ALICE, email: "alice@push.test" };
    const mine = (await (await route.DELETE(req("DELETE", { token: tok("alice1") }))).json()) as { removed: number };
    assert.equal(mine.removed, 1);
    assert.equal((await devices()).length, 0);
  });

  it("rejects malformed tokens, platforms and kinds", async () => {
    assert.equal((await route.POST(req("POST", { token: "not-a-token", platform: "ios" }))).status, 400);
    assert.equal((await route.POST(req("POST", { token: tok("x1"), platform: "windows" }))).status, 400);
    await route.POST(req("POST", { token: tok("x1"), platform: "android" }));
    assert.equal((await route.PATCH(req("PATCH", { token: tok("x1"), mutedKinds: ["invite_accepted"] }))).status, 400);
  });

  it("a token re-registered by another member moves to them with defaults", async () => {
    await route.POST(req("POST", { token: tok("shared"), platform: "android" }));
    await route.PATCH(req("PATCH", { token: tok("shared"), enabled: false }));
    actor = { id: BOB, email: "bob@push.test" };
    await route.POST(req("POST", { token: tok("shared"), platform: "android" }));
    const rows = await devices();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.userId, BOB);
    assert.equal(rows[0]!.enabled, true);
  });

  it("keeps at most MAX_DEVICES_PER_USER devices per user", async () => {
    for (let i = 0; i < MAX_DEVICES_PER_USER + 2; i++) {
      await withWorkspaceScope(WS, (tx) =>
        registerDevice(tx, { workspaceId: WS, userId: ALICE, token: tok(`cap${String(i).padStart(2, "0")}`), platform: "ios" }),
      );
    }
    const rows = await devices();
    assert.equal(rows.length, MAX_DEVICES_PER_USER);
    assert.ok(!rows.some((r) => r.expoToken === tok("cap00")), "oldest registration dropped");
  });

  it("push_devices is FORCE RLS", async () => {
    await route.POST(req("POST", { token: tok("rls"), platform: "ios" }));
    const role = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (role[0]!.rolsuper || role[0]!.rolbypassrls) return;
    const unscoped = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM push_devices`;
    assert.equal(unscoped[0]!.n, 0);
    assert.equal(await withWorkspaceScope(`${WS}-other`, (tx) => tx.pushDevice.count()), 0);
  });
});

describe("push delivery (Expo mocked)", () => {
  async function seed() {
    const reg = (userId: string, t: string, platform = "ios") =>
      withWorkspaceScope(WS, (tx) => registerDevice(tx, { workspaceId: WS, userId, token: tok(t), platform }));
    await reg(ALICE, "a-phone");
    await reg(ALICE, "a-tablet", "android");
    await reg(BOB, "b-phone");
  }

  it("does nothing unless PUSH_PROVIDER=expo", async () => {
    await seed();
    const { calls, fetchImpl } = expoMock();
    const res = await pushNotifications([note(ALICE, "approval_needed")], { fetchImpl, env: {} as NodeJS.ProcessEnv });
    assert.equal(res.skipped, "disabled");
    assert.equal(calls.length, 0);
  });

  it("sends to each recipient's enabled devices with the access token; skips non-push kinds", async () => {
    await seed();
    const { calls, fetchImpl } = expoMock();
    const res = await pushNotifications(
      [note(ALICE, "approval_needed"), note(BOB, "invite_accepted")],
      { fetchImpl, env: ENV },
    );
    assert.equal(res.sent, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, EXPO_PUSH_SEND_URL);
    assert.equal(calls[0]!.headers.authorization, "Bearer test-access-token");
    assert.deepEqual(calls[0]!.body.map((m) => m.to).sort(), [tok("a-phone"), tok("a-tablet")].sort());
    assert.equal(calls[0]!.body[0]!.data.href, "/dashboard/approvals?source=messaging");
    const rows = await devices();
    assert.ok(rows.filter((r) => r.userId === ALICE).every((r) => r.lastSentAt));
  });

  it("honors opt-out and muted kinds", async () => {
    await seed();
    await withWorkspaceScope(WS, (tx) =>
      tx.pushDevice.updateMany({ where: { workspaceId: WS, expoToken: tok("a-tablet") }, data: { enabled: false } }),
    );
    await withWorkspaceScope(WS, (tx) =>
      tx.pushDevice.updateMany({ where: { workspaceId: WS, expoToken: tok("b-phone") }, data: { mutedKinds: ["run_failed"] } }),
    );
    const { calls, fetchImpl } = expoMock();
    await pushNotifications([note(ALICE, "approval_decided"), note(BOB, "run_failed")], { fetchImpl, env: ENV });
    assert.deepEqual(calls.flatMap((c) => c.body.map((m) => m.to)), [tok("a-phone")]);
  });

  it("prunes DeviceNotRegistered at once and repeated failures after the limit", async () => {
    await seed();
    const { fetchImpl } = expoMock({
      [tok("a-phone")]: { status: "error", error: "DeviceNotRegistered" },
      [tok("a-tablet")]: { status: "error", error: "MessageRateExceeded" },
    });
    const res = await pushNotifications([note(ALICE, "approval_needed")], { fetchImpl, env: ENV });
    assert.equal(res.pruned, 1);
    let rows = await devices();
    assert.ok(!rows.some((r) => r.expoToken === tok("a-phone")));
    const tablet = rows.find((r) => r.expoToken === tok("a-tablet"))!;
    assert.equal(tablet.failureCount, 1);
    assert.equal(tablet.lastError, "MessageRateExceeded");

    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
      await pushNotifications([note(ALICE, "approval_needed")], { fetchImpl, env: ENV });
    }
    rows = await devices();
    assert.ok(!rows.some((r) => r.expoToken === tok("a-tablet")), "pruned after repeated failures");
    assert.ok(rows.some((r) => r.expoToken === tok("b-phone")), "other users' devices untouched");
  });

  it("a request-level failure touches no device and never throws", async () => {
    await seed();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS", message: "x" }] }), { status: 400 });
    const res = await pushNotifications([note(ALICE, "approval_needed")], { fetchImpl, env: ENV });
    assert.equal(res.sent, 0);
    const rows = await devices();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.failureCount === 0));
  });
});
