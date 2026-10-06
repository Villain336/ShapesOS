// ShapesOS — Phase 18.1 (integration) DB test: the notification producers
// apply BOTH workstreams' rules, in this order (lib/notifications/producers.ts
// createAndEmit):
//   1. the person's channels (WS=find, UserPreference.notifications): a muted
//      kind or the bell switched off → no row at all, focus or not;
//   2. focus / do not disturb (WS=desk, user_desk_state): the row is written
//      HELD (notifications.held_at) and not pushed;
//   3. push only for rows that are not held, to people whose push channel is
//      on; when focus ends the held row is released (bell) and pushed —
//      through the same push filter.
// Real Postgres as the least-privilege app role; push is observed through a
// MOCK of lib/push/notify (no Expo here), labelled as such.
// Run: DATABASE_URL=<app role> npx tsx --test --experimental-test-module-mocks lib/notifications/__tests__/focus-channels-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { NotificationInput } from "@/lib/notifications/store";

// MOCK: record what would be pushed instead of calling Expo.
const pushed: NotificationInput[] = [];
mock.module("@/lib/push/notify", {
  namedExports: {
    queuePushForNotifications: (inputs: NotificationInput[]) => {
      pushed.push(...inputs);
    },
  },
});

const RUN = randomUUID().slice(0, 8);
const WS = `p18int-ntf-${RUN}`;
const MUTED = `p18int-muted-${RUN}`; // owner: mutes approval_needed
const FOCUS = `p18int-focus-${RUN}`; // admin: in focus, all channels on
const PLAIN = `p18int-plain-${RUN}`; // editor: no preferences row (defaults)
const QUIET = `p18int-quiet-${RUN}`; // editor: in focus, push switched off
const USERS = [MUTED, FOCUS, PLAIN, QUIET];

let prisma: typeof import("@/lib/prisma").prisma;
let producers: typeof import("@/lib/notifications/producers");
let store: typeof import("@/lib/notifications/store");
let focus: typeof import("@/lib/desktop/focus.server");
let prefs: typeof import("@/lib/preferences");

async function cleanup() {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.notification.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.userDeskState.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.userPreference.deleteMany({ where: { userId: { in: USERS } } });
}

const pushedTo = (sourceId: string) =>
  pushed
    .filter((n) => n.sourceId === sourceId)
    .map((n) => n.userId)
    .sort();

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  producers = await import("@/lib/notifications/producers");
  store = await import("@/lib/notifications/store");
  focus = await import("@/lib/desktop/focus.server");
  prefs = await import("@/lib/preferences");
  await cleanup();
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: MUTED } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: MUTED, role: "owner" },
      { workspaceId: WS, userId: FOCUS, role: "admin" },
      { workspaceId: WS, userId: PLAIN, role: "editor" },
      { workspaceId: WS, userId: QUIET, role: "editor" },
    ],
  });
  await prefs.setUserPreference(MUTED, "notifications", { inApp: true, push: true, mutedKinds: ["approval_needed"] });
  await prefs.setUserPreference(QUIET, "notifications", { inApp: true, push: false, mutedKinds: [] });
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("notification producers: channel filter → focus hold → push", () => {
  it("a muted kind is never written — not even held while its owner is in focus", async () => {
    await focus.startFocus(MUTED, { minutes: 60 });
    pushed.length = 0;
    await producers.notifyApprovalNeeded({ workspaceId: WS, source: "cad", sourceId: `muted-${RUN}`, title: "Check the wall", decideRole: "owner" }, prisma);
    assert.equal(await prisma.notification.count({ where: { userId: MUTED, sourceId: `muted-${RUN}` } }), 0);
    await focus.endFocus(MUTED);
    assert.equal(await prisma.notification.count({ where: { userId: MUTED } }), 0, "nothing to release either");
    assert.deepEqual(pushedTo(`muted-${RUN}`).includes(MUTED), false);
  });

  it("an unmuted kind during focus is written held and not pushed; others get it and their push now", async () => {
    await focus.startFocus(FOCUS, { minutes: 60 });
    await focus.startFocus(QUIET, { minutes: 60 });
    pushed.length = 0;
    const sid = `held-${RUN}`;
    const created = await producers.notifyApprovalNeeded({ workspaceId: WS, source: "cad", sourceId: sid, title: "Thicken the slab" }, prisma);
    assert.equal(created, 3, "FOCUS, PLAIN and QUIET get a row; MUTED does not");

    const row = (u: string) => prisma.notification.findFirst({ where: { userId: u, sourceId: sid } });
    assert.equal(await row(MUTED), null);
    assert.ok((await row(FOCUS))?.heldAt, "in focus: held");
    assert.ok((await row(QUIET))?.heldAt, "in focus: held");
    assert.equal((await row(PLAIN))?.heldAt, null, "not in focus: delivered now");

    // Only the delivered row pushed (QUIET switched push off anyway).
    assert.deepEqual(pushedTo(sid), [PLAIN]);
    // Held rows stay out of the bell until focus ends.
    assert.equal(await store.unreadCount(prisma, { userId: FOCUS, workspaceId: WS }), 0);
    assert.equal(await store.unreadCount(prisma, { userId: PLAIN, workspaceId: WS }), 1);
  });

  it("after focus ends the held row is released to the bell and pushed — through the push filter", async () => {
    const sid = `held-${RUN}`;
    pushed.length = 0;
    const a = await focus.endFocus(FOCUS);
    assert.equal(a.released, 1);
    assert.equal(await store.unreadCount(prisma, { userId: FOCUS, workspaceId: WS }), 1, "in the bell now");
    assert.deepEqual(pushedTo(sid), [FOCUS], "released and pushed");

    pushed.length = 0;
    const b = await focus.endFocus(QUIET);
    assert.equal(b.released, 1);
    assert.equal(await store.unreadCount(prisma, { userId: QUIET, workspaceId: WS }), 1, "in the bell now");
    assert.deepEqual(pushedTo(sid), [], "push switched off: released to the bell only");

    // Releasing again is a no-op (each row is claimed once).
    pushed.length = 0;
    assert.equal(await focus.releaseHeldNotifications(FOCUS), 0);
    assert.deepEqual(pushed, []);
  });

  it("an expired focus is released by the cron sweep with the same push rule", async () => {
    const sid = `sweep-${RUN}`;
    await focus.startFocus(FOCUS, { minutes: 60 });
    await producers.notifyApprovalNeeded({ workspaceId: WS, source: "cad", sourceId: sid, title: "Move the door" }, prisma);
    assert.ok((await prisma.notification.findFirstOrThrow({ where: { userId: FOCUS, sourceId: sid } })).heldAt);
    // Focus ran out (end time moved into the past, as if an hour went by).
    await prisma.userDeskState.update({ where: { userId: FOCUS }, data: { focusUntil: new Date(Date.now() - 1000) } });
    pushed.length = 0;
    const sweep = await focus.releaseEndedFocus();
    assert.ok(sweep.released >= 1);
    assert.equal((await prisma.notification.findFirstOrThrow({ where: { userId: FOCUS, sourceId: sid } })).heldAt, null);
    assert.deepEqual(pushedTo(sid), [FOCUS]);
  });
});
