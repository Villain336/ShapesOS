// ShapesOS — Phase 3 (J) DB test: notification center against real Postgres.
// Per-user read state, workspace scoping, dedup on the unique index, and the
// producers wired into real actions: requesting/deciding an approval item,
// a failed agent run, and a claimed invite.
// Run: npx tsx --test lib/notifications/__tests__/notifications-db.test.ts
// Requires DATABASE_URL (listed in scripts/test/db-tests.txt).

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { claimInviteToken, mintInviteToken } from "@/lib/authz";
import { requestApproval, decideApproval } from "@/lib/messaging/approvals";
import { createAgentRun, finishAgentRun } from "@/lib/agents/runs/service";
import { notifyApprovalNeeded } from "../producers";
import { createNotifications, listNotifications, markAllRead, markRead, unreadCount } from "../store";

const WS = "p3j-notif-ws";
const WS2 = "p3j-notif-ws2";
const OWNER = "p3j-notif-owner";
const EDITOR = "p3j-notif-editor";
const VIEWER = "p3j-notif-viewer";
const INVITEE = "p3j-notif-invitee";

const kinds = async (userId: string, workspaceId = WS) =>
  (await prisma.notification.findMany({ where: { userId, workspaceId }, select: { kind: true } })).map((r) => r.kind);

before(async () => {
  for (const id of [WS, WS2]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER } });
  await prisma.workspace.create({ data: { id: WS2, name: WS2, ownerUserId: OWNER } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: OWNER, role: "owner" },
      { workspaceId: WS, userId: EDITOR, role: "editor" },
      { workspaceId: WS, userId: VIEWER, role: "viewer" },
      { workspaceId: WS2, userId: OWNER, role: "owner" },
    ],
  });
});

after(async () => {
  for (const id of [WS, WS2]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("notifications (DB)", () => {
  it("requesting an approval notifies the deciders (not the requester, not viewers); deciding notifies the requester", async () => {
    const item = await requestApproval({ workspaceId: WS, kind: "sequence_send", payload: { subject: "Hi Ada" }, requestedBy: EDITOR });
    const needed = await prisma.notification.findMany({ where: { workspaceId: WS, sourceId: item.id, kind: "approval_needed" } });
    assert.deepEqual(needed.map((n) => n.userId), [OWNER]);
    assert.equal(needed[0]!.body, "Hi Ada");
    assert.equal(needed[0]!.href, "/dashboard/approvals?source=messaging");

    await decideApproval(item.id, WS, "approve", OWNER);
    const decided = await prisma.notification.findMany({ where: { workspaceId: WS, sourceId: item.id, kind: "approval_decided" } });
    assert.deepEqual(decided.map((n) => n.userId), [EDITOR]);
    assert.equal(decided[0]!.title, "Messaging and nurture approved");
  });

  it("producers are idempotent through the (user, dedupKey) unique index", async () => {
    const input = { workspaceId: WS, source: "cad" as const, sourceId: "p3j-cad-1", title: "Thicken wall" };
    assert.equal(await notifyApprovalNeeded(input, prisma), 2);
    assert.equal(await notifyApprovalNeeded(input, prisma), 0);
    assert.equal(await prisma.notification.count({ where: { workspaceId: WS, sourceId: "p3j-cad-1" } }), 2);
  });

  it("read state is per user and per workspace", async () => {
    await createNotifications(prisma, [
      { workspaceId: WS, userId: OWNER, kind: "alert_fired", title: "A1", dedupKey: "p3j-a1" },
      { workspaceId: WS, userId: VIEWER, kind: "alert_fired", title: "A1", dedupKey: "p3j-a1" },
      { workspaceId: WS2, userId: OWNER, kind: "alert_fired", title: "Other ws", dedupKey: "p3j-a2" },
    ]);
    const viewerRow = await prisma.notification.findFirstOrThrow({ where: { userId: VIEWER, dedupKey: "p3j-a1" } });

    // Another member's id is ignored.
    assert.equal(await markRead(prisma, { userId: OWNER, workspaceId: WS, ids: [viewerRow.id] }), 0);
    assert.equal(await unreadCount(prisma, { userId: VIEWER, workspaceId: WS }), 1);

    const before = await unreadCount(prisma, { userId: OWNER, workspaceId: WS });
    assert.ok(before >= 2);
    assert.equal(await markAllRead(prisma, { userId: OWNER, workspaceId: WS }), before);
    assert.equal(await unreadCount(prisma, { userId: OWNER, workspaceId: WS }), 0);
    assert.equal(await unreadCount(prisma, { userId: OWNER, workspaceId: WS2 }), 1, "other workspace untouched");
    assert.equal(await unreadCount(prisma, { userId: VIEWER, workspaceId: WS }), 1, "other member untouched");

    const list = await listNotifications(prisma, { userId: OWNER, workspaceId: WS2 });
    assert.deepEqual(list.map((n) => n.title), ["Other ws"]);
  });

  it("a failed agent run notifies the member who started it", async () => {
    const run = await createAgentRun({ workspaceId: WS, kind: "browser", startedBy: VIEWER });
    await finishAgentRun(WS, run.id, "failed");
    const rows = await prisma.notification.findMany({ where: { workspaceId: WS, kind: "run_failed", sourceId: run.id } });
    assert.deepEqual(rows.map((r) => r.userId), [VIEWER]);
    assert.equal(rows[0]!.href, `/dashboard/runs/${run.id}`);

    const ok = await createAgentRun({ workspaceId: WS, kind: "browser", startedBy: VIEWER });
    await finishAgentRun(WS, ok.id, "succeeded");
    assert.equal(await prisma.notification.count({ where: { sourceId: ok.id } }), 0);
  });

  it("a claimed invite notifies the owners and admins", async () => {
    const { inviteToken, inviteExpiresAt } = mintInviteToken();
    await prisma.workspaceMember.create({
      data: { workspaceId: WS, email: "invitee@example.com", role: "editor", inviteToken, inviteExpiresAt },
    });
    const member = await claimInviteToken(INVITEE, "invitee@example.com", inviteToken);
    assert.ok(member);
    assert.ok((await kinds(OWNER)).includes("invite_accepted"));
    assert.ok(!(await kinds(INVITEE)).includes("invite_accepted"));
    assert.ok(!(await kinds(VIEWER)).includes("invite_accepted"));
  });
});
