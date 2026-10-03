// ShapesOS — Phase 3 (J) unit tests: notification producers + store rules.
// Recipients follow the workspace membership and each queue's decide role,
// producers are idempotent (dedupKey) and best-effort (never throw), and
// links can only point inside the dashboard. No database: a fake client.
// Run: npx tsx --test lib/notifications/__tests__/producers.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  actorUserId,
  membersAtLeast,
  notifyAgentRunFailed,
  notifyAlertFired,
  notifyApprovalDecided,
  notifyApprovalNeeded,
  notifyInviteAccepted,
  type ProducerDb,
} from "../producers";
import { listNotifications, markAllRead, markRead, safeHref, unreadCount, type NotificationDb } from "../store";
import { fakeDb } from "../../approvals/__tests__/fake-db";

const WS = "ws_n";
const OTHER = "ws_other";

function setup() {
  const fake = fakeDb({
    workspace: [
      { id: WS, ownerUserId: "u_legacy_owner" },
      { id: OTHER, ownerUserId: "u_x" },
    ],
    workspaceMember: [
      { id: "m1", workspaceId: WS, userId: "u_owner", role: "owner" },
      { id: "m2", workspaceId: WS, userId: "u_admin", role: "admin" },
      { id: "m3", workspaceId: WS, userId: "u_editor", role: "editor" },
      { id: "m4", workspaceId: WS, userId: "u_viewer", role: "viewer" },
      { id: "m5", workspaceId: WS, userId: null, role: "editor", email: "pending@example.com" },
      { id: "m6", workspaceId: OTHER, userId: "u_outsider", role: "owner" },
    ],
    notification: [],
  });
  return { fake, db: fake.db as unknown as ProducerDb, rows: () => fake.tables.notification as Array<Record<string, unknown>> };
}

const recipients = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.userId as string).sort();

describe("notification producers: recipients", () => {
  it("membersAtLeast includes a legacy owner, skips pending invites and other workspaces", async () => {
    const { db } = setup();
    assert.deepEqual(
      (await membersAtLeast(db, WS, "editor")).sort(),
      ["u_admin", "u_editor", "u_legacy_owner", "u_owner"],
    );
    assert.deepEqual((await membersAtLeast(db, WS, "admin")).sort(), ["u_admin", "u_legacy_owner", "u_owner"]);
  });

  it("approval needed → every member who can decide, minus the requester", async () => {
    const { db, rows } = setup();
    const n = await notifyApprovalNeeded(
      { workspaceId: WS, source: "messaging", sourceId: "a1", title: "Hello → ada", requestedBy: "u_editor" },
      db,
    );
    assert.equal(n, 3);
    assert.deepEqual(recipients(rows()), ["u_admin", "u_legacy_owner", "u_owner"]);
    const row = rows()[0]!;
    assert.equal(row.kind, "approval_needed");
    assert.equal(row.workspaceId, WS);
    assert.equal(row.href, "/dashboard/approvals?source=messaging");
    assert.equal(row.dedupKey, "approval_needed:messaging:a1");
    assert.equal(row.title, "Messaging and nurture needs your approval");
  });

  it("is idempotent per recipient (same approval twice = one row each)", async () => {
    const { db, rows } = setup();
    const input = { workspaceId: WS, source: "mission" as const, sourceId: "m1", title: "Send" };
    await notifyApprovalNeeded(input, db);
    assert.equal(await notifyApprovalNeeded(input, db), 0);
    assert.equal(rows().length, 4);
  });

  it("decideRole narrows recipients (media buys, supervised runs → admin+)", async () => {
    const { db, rows } = setup();
    await notifyApprovalNeeded({ workspaceId: WS, source: "media", sourceId: "b1", title: "Meta", decideRole: "admin" }, db);
    assert.ok(!recipients(rows()).includes("u_editor"));
    assert.ok(!recipients(rows()).includes("u_viewer"));
  });

  it("approval decided → only the requester, never the decider or an agent", async () => {
    const { db, rows } = setup();
    assert.equal(
      await notifyApprovalDecided(
        { workspaceId: WS, source: "integration", sourceId: "t1", title: "Post", decision: "approved", decidedBy: "u_owner", requestedBy: "u_editor (playbook:x)" },
        db,
      ),
      1,
    );
    assert.deepEqual(recipients(rows()), ["u_editor"]);
    assert.equal(rows()[0]!.title, "Tool action approved");

    assert.equal(
      await notifyApprovalDecided(
        { workspaceId: WS, source: "mission", sourceId: "t2", title: "x", decision: "denied", decidedBy: "u_editor", requestedBy: "u_editor" },
        db,
      ),
      0,
      "deciding your own request notifies nobody",
    );
    assert.equal(
      await notifyApprovalDecided(
        { workspaceId: WS, source: "mission", sourceId: "t3", title: "x", decision: "denied", decidedBy: "u_owner", requestedBy: "agent:planner" },
        db,
      ),
      0,
    );
    assert.equal(
      await notifyApprovalDecided(
        { workspaceId: WS, source: "mission", sourceId: "t4", title: "x", decision: "denied", decidedBy: "u_owner", requestedBy: "u_outsider" },
        db,
      ),
      0,
      "a requester id from another workspace is not notified here",
    );
  });

  it("alert fired → every member; off-dashboard links fall back to the alerts page", async () => {
    const { db, rows } = setup();
    await notifyAlertFired({ workspaceId: WS, eventId: "e1", title: "Rank drop", link: "https://evil.example/x" }, db);
    assert.equal(rows().length, 5);
    assert.ok(rows().every((r) => r.href === "/dashboard/alerts" && r.kind === "alert_fired"));
  });

  it("agent run failed → whoever started it; editors+ when an agent started it", async () => {
    const one = setup();
    await notifyAgentRunFailed({ workspaceId: WS, runId: "r1", kind: "browser", startedBy: "u_viewer" }, one.db);
    assert.deepEqual(recipients(one.rows()), ["u_viewer"]);
    assert.equal(one.rows()[0]!.href, "/dashboard/runs/r1");
    assert.equal(one.rows()[0]!.title, "Browser run failed");

    const two = setup();
    await notifyAgentRunFailed({ workspaceId: WS, runId: "r2", startedBy: "agent:mission" }, two.db);
    assert.deepEqual(recipients(two.rows()), ["u_admin", "u_editor", "u_legacy_owner", "u_owner"]);
  });

  it("invite accepted → admins and owners, not the new member", async () => {
    const { db, rows } = setup();
    await notifyInviteAccepted({ workspaceId: WS, memberUserId: "u_admin", email: "new@example.com", role: "admin" }, db);
    assert.deepEqual(recipients(rows()), ["u_legacy_owner", "u_owner"]);
    assert.equal(rows()[0]!.title, "new@example.com joined the workspace");
  });

  it("is best-effort: a broken database never throws into the caller", async () => {
    const broken = fakeDb({}, { fail: ["workspaceMember", "notification", "workspace"] });
    const db = broken.db as unknown as ProducerDb;
    assert.equal(await notifyApprovalNeeded({ workspaceId: WS, source: "cad", sourceId: "c", title: "t" }, db), 0);
    assert.equal(await notifyAlertFired({ workspaceId: WS, eventId: "e", title: "t" }, db), 0);
    assert.equal(await notifyAgentRunFailed({ workspaceId: WS, runId: "r" }, db), 0);
    assert.equal(await notifyInviteAccepted({ workspaceId: WS, memberUserId: "u" }, db), 0);
    assert.equal(
      await notifyApprovalDecided({ workspaceId: WS, source: "cad", sourceId: "c", title: "t", decision: "approved", requestedBy: "u_editor" }, db),
      0,
    );
  });

  it("actorUserId keeps user ids and drops agents, emails and system", () => {
    assert.equal(actorUserId("u_1"), "u_1");
    assert.equal(actorUserId("u_1 (playbook:abc)"), "u_1");
    assert.equal(actorUserId("agent:planner"), null);
    assert.equal(actorUserId("ada@example.com"), null);
    assert.equal(actorUserId("system"), null);
    assert.equal(actorUserId(null), null);
  });
});

describe("notification store: read state", () => {
  function seeded() {
    const fake = fakeDb({
      notification: [
        { id: "n1", workspaceId: WS, userId: "u_a", kind: "alert_fired", title: "1", readAt: null, createdAt: new Date("2026-10-03T10:00:00Z") },
        { id: "n2", workspaceId: WS, userId: "u_a", kind: "alert_fired", title: "2", readAt: null, createdAt: new Date("2026-10-03T11:00:00Z") },
        { id: "n3", workspaceId: WS, userId: "u_b", kind: "alert_fired", title: "3", readAt: null, createdAt: new Date("2026-10-03T11:00:00Z") },
        { id: "n4", workspaceId: OTHER, userId: "u_a", kind: "alert_fired", title: "4", readAt: null, createdAt: new Date("2026-10-03T11:00:00Z") },
      ],
    });
    return { db: fake.db as unknown as NotificationDb, rows: fake.tables.notification as Array<Record<string, unknown>> };
  }

  it("markRead only touches the caller's own notifications in this workspace", async () => {
    const { db, rows } = seeded();
    const updated = await markRead(db, { userId: "u_a", workspaceId: WS, ids: ["n1", "n3", "n4"] });
    assert.equal(updated, 1);
    assert.ok(rows.find((r) => r.id === "n1")!.readAt);
    assert.equal(rows.find((r) => r.id === "n3")!.readAt, null, "another member's notification");
    assert.equal(rows.find((r) => r.id === "n4")!.readAt, null, "another workspace");
  });

  it("markAllRead is per user and per workspace; unreadCount follows", async () => {
    const { db } = seeded();
    assert.equal(await unreadCount(db, { userId: "u_a", workspaceId: WS }), 2);
    assert.equal(await markAllRead(db, { userId: "u_a", workspaceId: WS }), 2);
    assert.equal(await unreadCount(db, { userId: "u_a", workspaceId: WS }), 0);
    assert.equal(await unreadCount(db, { userId: "u_b", workspaceId: WS }), 1);
    assert.equal(await unreadCount(db, { userId: "u_a", workspaceId: OTHER }), 1);
  });

  it("listNotifications returns only the caller's rows, unread filter respected", async () => {
    const { db } = seeded();
    await markRead(db, { userId: "u_a", workspaceId: WS, ids: ["n1"] });
    const all = await listNotifications(db, { userId: "u_a", workspaceId: WS });
    assert.deepEqual(all.map((n) => n.id).sort(), ["n1", "n2"]);
    const unread = await listNotifications(db, { userId: "u_a", workspaceId: WS, unreadOnly: true });
    assert.deepEqual(unread.map((n) => n.id), ["n2"]);
  });

  it("safeHref keeps dashboard paths and rejects everything else", () => {
    assert.equal(safeHref("/dashboard/runs/r1"), "/dashboard/runs/r1");
    assert.equal(safeHref("https://evil.example"), null);
    assert.equal(safeHref("//evil.example/dashboard"), null);
    assert.equal(safeHref("/dashboard\\..\\x"), null);
    assert.equal(safeHref("javascript:alert(1)"), null);
    assert.equal(safeHref(undefined), null);
  });
});
