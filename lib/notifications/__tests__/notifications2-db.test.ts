// ShapesOS — Phase 18.3 (WS=trust) DB test: Notifications 2.0.
//   - each new kind (run finished, invoice paid, ticket assigned, meeting
//     starting) is produced ONCE for a repeated event (dedup) and held under
//     focus / do not disturb (released when focus ends);
//   - the producers reach them at their event points: a succeeded run
//     (finishAgentRun), an ops write that pays an invoice or assigns a ticket
//     (the ops webhook seam), the meeting sweep over calendar events;
//   - delivery follows the person's channel matrix: phone push (a MOCK of
//     lib/push/notify), Slack DMs through a STUB delivery (no Slack here),
//     and the daily email digest through a STUB sender (no SMTP here): each
//     row mailed once, a muted / email-off kind never.
// Real Postgres as the least-privilege app role.
// Run: DATABASE_URL=<app role> npx tsx --test --experimental-test-module-mocks lib/notifications/__tests__/notifications2-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { NotificationInput } from "@/lib/notifications/store";

// MOCK: what would be pushed to phones (no Expo here).
const pushed: NotificationInput[] = [];
mock.module("@/lib/push/notify", {
  namedExports: {
    queuePushForNotifications: (inputs: NotificationInput[]) => {
      pushed.push(...inputs);
    },
  },
});

const RUN = randomUUID().slice(0, 8);
const WS = `n2-ws-${RUN}`;
const OWNER = `n2-owner-${RUN}`; // admin+: invoices
const AGENT_USER = `n2-ed-${RUN}`; // editor: assignee, runs, meetings
const FOCUSED = `n2-focus-${RUN}`; // admin in focus
const USERS = [OWNER, AGENT_USER, FOCUSED];

let prisma: typeof import("@/lib/prisma").prisma;
let producers: typeof import("../producers");
let focus: typeof import("@/lib/desktop/focus.server");
let prefs: typeof import("@/lib/preferences");
let deliver: typeof import("../deliver");

const count = (where: Record<string, unknown>) => prisma.notification.count({ where: { workspaceId: WS, ...where } });
const tick = () => new Promise((r) => setTimeout(r, 50));

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  producers = await import("../producers");
  focus = await import("@/lib/desktop/focus.server");
  prefs = await import("@/lib/preferences");
  deliver = await import("../deliver");
  await prisma.workspace.create({ data: { id: WS, name: "N2 Acme", ownerUserId: OWNER } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: OWNER, role: "owner", email: "owner@n2.test" },
      { workspaceId: WS, userId: AGENT_USER, role: "editor", email: "ed@n2.test" },
      { workspaceId: WS, userId: FOCUSED, role: "admin", email: "focus@n2.test" },
    ],
  });
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.notification.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.userDeskState.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.userPreference.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.$disconnect();
});

describe("Notifications 2.0: the new kinds (DB)", () => {
  it("run finished: once per run, from finishAgentRun; quick chat turns and sub-agents stay quiet", async () => {
    const { createAgentRun, finishAgentRun } = await import("@/lib/agents/runs/service");
    const run = await createAgentRun({ workspaceId: WS, kind: "mission", startedBy: AGENT_USER, agentKey: "lead" });
    await finishAgentRun(WS, run.id, "succeeded");
    await producers.notifyRunFinished({ workspaceId: WS, runId: run.id, kind: "mission", startedBy: AGENT_USER });
    assert.equal(await count({ kind: "run_finished", sourceId: run.id }), 1, "dedup: once per run");
    const chat = await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: AGENT_USER, agentKey: "lead" });
    await finishAgentRun(WS, chat.id, "succeeded");
    assert.equal(await count({ kind: "run_finished", sourceId: chat.id }), 0, "a quick chat turn the person watched");
  });

  it("invoice paid: from the ops seam, to admins and owners, once", async () => {
    const { emitOpsWriteEvents } = await import("@/lib/webhooks/ops-events");
    const before = { id: `inv-${RUN}`, status: "sent", kind: "invoice" };
    const after = { ...before, status: "paid", number: "INV-0042", totalCents: 125000 };
    await prisma.$transaction((tx) => emitOpsWriteEvents(tx as never, WS, "invoices", before, after, AGENT_USER));
    await prisma.$transaction((tx) => emitOpsWriteEvents(tx as never, WS, "invoices", before, after, AGENT_USER));
    await tick();
    const rows = await prisma.notification.findMany({ where: { workspaceId: WS, kind: "invoice_paid" }, select: { userId: true, title: true } });
    assert.deepEqual(rows.map((r) => r.userId).sort(), [FOCUSED, OWNER].sort(), "admins and owners, once each");
    assert.equal(rows[0]!.title, "Invoice INV-0042 was paid in full");
  });

  it("ticket assigned: the assignee, once per assignment; never when you assign yourself", async () => {
    const { emitOpsWriteEvents } = await import("@/lib/webhooks/ops-events");
    const at = new Date().toISOString();
    const t = { id: `tk-${RUN}`, number: 12, subject: "Printer jam", assigneeId: null, updatedAt: at };
    await prisma.$transaction((tx) => emitOpsWriteEvents(tx as never, WS, "tickets", t, { ...t, assigneeId: AGENT_USER }, OWNER));
    await prisma.$transaction((tx) => emitOpsWriteEvents(tx as never, WS, "tickets", t, { ...t, assigneeId: AGENT_USER }, OWNER));
    await tick();
    assert.equal(await count({ kind: "ticket_assigned", userId: AGENT_USER }), 1);
    const self = { id: `tk2-${RUN}`, number: 13, subject: "Mine", assigneeId: null, updatedAt: at };
    await prisma.$transaction((tx) => emitOpsWriteEvents(tx as never, WS, "tickets", self, { ...self, assigneeId: OWNER }, OWNER));
    await tick();
    assert.equal(await count({ kind: "ticket_assigned", userId: OWNER }), 0);
  });

  it("meeting starting: the sweep notifies once per occurrence, only events in the next ten minutes", async () => {
    const { sweepMeetingsStarting } = await import("../meetings.server");
    const now = new Date();
    const soon = new Date(now.getTime() + 5 * 60_000).toISOString();
    const later = new Date(now.getTime() + 60 * 60_000).toISOString();
    const loadEvents = async (ctx: { userId: string }) =>
      ctx.userId === AGENT_USER
        ? ([
            { id: `google:c1:ev-${RUN}`, source: "google", title: "Sales call", start: soon, end: null, allDay: false, location: null, attendees: [], href: "/dashboard/calendar", externalUrl: null, editable: false, connectionId: null, externalId: null, mock: false },
            { id: `google:c1:later-${RUN}`, source: "google", title: "Later", start: later, end: null, allDay: false, location: null, attendees: [], href: null, externalUrl: null, editable: false, connectionId: null, externalId: null, mock: false },
          ] as never)
        : [];
    const deps = { loadEvents, timeZoneOf: async () => "UTC" };
    const first = await sweepMeetingsStarting({ workspaceIds: [WS], now, deps });
    const second = await sweepMeetingsStarting({ workspaceIds: [WS], now: new Date(now.getTime() + 60_000), deps });
    assert.equal(first.notified, 1);
    assert.equal(second.notified, 0, "dedup across sweeps");
    const row = await prisma.notification.findFirstOrThrow({ where: { workspaceId: WS, kind: "meeting_starting", userId: AGENT_USER } });
    assert.match(row.title, /^Sales call starts (in \d+ minutes|now)$/);
  });

  it("held under focus, and released (and pushed) when focus ends", async () => {
    await focus.startFocus(FOCUSED, { minutes: 60 });
    pushed.length = 0;
    const id = `inv2-${RUN}`;
    await producers.notifyInvoicePaid({ workspaceId: WS, invoiceId: id, number: "INV-7", totalCents: 100 });
    const held = await prisma.notification.findFirstOrThrow({ where: { userId: FOCUSED, sourceId: id } });
    assert.ok(held.heldAt, "held while in focus");
    await deliver.settleDeliveries();
    assert.ok(!pushed.some((n) => n.userId === FOCUSED), "no push while held");
    // invoice_paid isn't on the phone by default: the person turns it on.
    await prefs.setUserPreference(FOCUSED, "notifications", { inApp: true, push: true, mutedKinds: [], channels: { invoice_paid: { push: true } } });
    const released = await focus.endFocus(FOCUSED);
    assert.equal(released.released, 1);
    assert.deepEqual(pushed.filter((n) => n.sourceId === id).map((n) => n.userId), [FOCUSED], "released and pushed per the matrix");
  });

  it("a muted kind is never written", async () => {
    await prefs.setUserPreference(AGENT_USER, "notifications", { inApp: true, push: true, mutedKinds: ["meeting_starting"] });
    const n = await producers.notifyMeetingStarting({ workspaceId: WS, userId: AGENT_USER, eventId: `booking:mute-${RUN}`, title: "Muted", startsAt: new Date(Date.now() + 60_000) });
    assert.equal(n, 0);
    await prefs.setUserPreference(AGENT_USER, "notifications", { inApp: true, push: true, mutedKinds: [] });
  });
});

describe("Notifications 2.0: channels through stubs (DB)", () => {
  it("Slack DMs go only to people whose Slack channel is on for the kind (STUB delivery)", async () => {
    await prefs.setUserPreference(OWNER, "notifications", { inApp: true, push: true, mutedKinds: [], slack: true });
    const slack: NotificationInput[] = [];
    const inputs: NotificationInput[] = [OWNER, AGENT_USER].map((userId) => ({ workspaceId: WS, userId, kind: "ticket_assigned", title: "Ticket #99 was assigned to you" }));
    await deliver.deliverNow(inputs, { slack: async (list) => void slack.push(...list), push: () => undefined, webPush: async () => undefined });
    await deliver.settleDeliveries();
    assert.deepEqual(slack.map((n) => n.userId), [OWNER], "only the person who turned Slack on");
    const { deliverSlack } = await import("../slack");
    const sent: string[] = [];
    const r = await deliverSlack(slack, {
      installation: async () => ({ connectionId: "conn-stub" }),
      emailOf: async (_w, u) => (u === OWNER ? "owner@n2.test" : null),
      sendDm: async (_c, email, text) => {
        sent.push(`${email}|${text}`);
        return true;
      },
      appUrl: () => "https://app.example.com",
    });
    assert.deepEqual(r, { sent: 1, skipped: 0 });
    assert.match(sent[0]!, /^owner@n2\.test\|\*Ticket #99 was assigned to you\*/);
  });

  it("the email digest (STUB sender): unread rows once a day, muted / email-off kinds never", async () => {
    const { sendDigestFor } = await import("../digest.server");
    await prefs.setUserPreference(OWNER, "notifications", { inApp: true, push: true, mutedKinds: [], emailDigest: "daily", channels: { ticket_assigned: { email: false } } });
    await producers.notifyTicketAssigned({ workspaceId: WS, ticketId: `dg-${RUN}`, number: 5, subject: "Excluded by the cell", assigneeId: OWNER, assignedBy: AGENT_USER, at: new Date() });
    const p = await prefs.getUserPreferences(OWNER);
    const morning = new Date();
    morning.setUTCHours(10, 0, 0, 0);
    const mails: Array<{ to: string; title: string; body: string }> = [];
    const send = async (to: string, payload: { title: string; body: string }) => {
      mails.push({ to, title: payload.title, body: payload.body });
      return { ok: true };
    };
    const early = new Date(morning);
    early.setUTCHours(5);
    assert.equal((await sendDigestFor(OWNER, p, early, { send, appUrl: () => "https://app.example.com" })).status, "not_due");
    const r = await sendDigestFor(OWNER, p, morning, { send, appUrl: () => "https://app.example.com" });
    assert.equal(r.status, "sent");
    assert.ok(r.rows >= 2, `rows ${r.rows}`);
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to, "owner@n2.test");
    assert.match(mails[0]!.body, /N2 Acme — \d+ unread/);
    assert.match(mails[0]!.body, /Invoice INV-0042 was paid in full/);
    assert.ok(!mails[0]!.body.includes("Excluded by the cell"), "the person turned email off for this kind");
    assert.match(mails[0]!.body, /https:\/\/app\.example\.com\/dashboard\//);
    const again = await sendDigestFor(OWNER, p, new Date(morning.getTime() + 3600_000), { send });
    assert.equal(again.status, "already_sent");
    assert.equal(mails.length, 1, "once a day");
    // A failed send marks nothing (retried next sweep).
    await prisma.notification.updateMany({ where: { userId: OWNER }, data: { digestedAt: null } });
    const failed = await sendDigestFor(OWNER, p, morning, { send: async () => ({ ok: false, error: "smtp down" }) });
    assert.equal(failed.status, "failed");
    assert.equal(await prisma.notification.count({ where: { userId: OWNER, digestedAt: { not: null } } }), 0);
  });
});
