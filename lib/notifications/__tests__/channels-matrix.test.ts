// ShapesOS — Phase 18.3 (WS=trust): Notifications 2.0, the pure parts (unit).
// The channel matrix, digest assembly, ops notices, "run finished" worthiness,
// the Slack DM text + delivery through a STUB, and the meeting window.
// Run: npx tsx --test lib/notifications/__tests__/channels-matrix.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFERENCES, NOTIFICATION_KINDS, NOTIFICATION_CHANNELS, coercePreferences, type NotificationPrefs } from "@/lib/preferences/schema";
import { DEFAULT_KIND_CHANNELS, cellAvailable, channelAllows, channelOn } from "../channels";
import { assembleDigest, buildSummaryPrompt } from "../digest";
import { opsNotices } from "../ops";
import { runFinishedWorthNotifying } from "../producers";
import { deliverSlack, slackText } from "../slack";
import { startingSoon } from "../meetings.server";
import { PUSH_KINDS } from "@/lib/push/devices";
import type { CalendarEvent } from "@/lib/comms/calendar/sources.server";

const base = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({ ...DEFAULT_PREFERENCES.notifications, ...over });

describe("notification channel matrix", () => {
  it("every kind has a default for every channel", () => {
    for (const k of NOTIFICATION_KINDS) for (const c of NOTIFICATION_CHANNELS) assert.equal(typeof DEFAULT_KIND_CHANNELS[k][c], "boolean", `${k}/${c}`);
  });

  it("defaults keep today's behaviour: every kind in the bell; the opt-in channels off", () => {
    const p = base();
    for (const k of NOTIFICATION_KINDS) assert.equal(channelAllows(p, k, "inApp"), true, k);
    for (const k of NOTIFICATION_KINDS) {
      assert.equal(channelAllows(p, k, "webPush"), false);
      assert.equal(channelAllows(p, k, "email"), false);
      assert.equal(channelAllows(p, k, "slack"), false);
    }
    for (const k of ["approval_needed", "approval_decided", "run_failed"]) assert.equal(channelAllows(p, k, "push"), true, `${k} still pushes`);
    assert.equal(channelAllows(p, "alert_fired", "push"), false);
  });

  it("the 18.2 and 18.3 kinds become pushable", () => {
    const p = base();
    for (const k of ["mention", "direct_message", "reminder_due", "ticket_assigned", "meeting_starting"]) assert.equal(channelAllows(p, k, "push"), true, k);
    for (const k of ["run_finished", "invoice_paid"]) assert.equal(channelAllows(p, k, "push"), false, `${k}: off by default, can be turned on`);
    assert.equal(channelAllows(base({ channels: { invoice_paid: { push: true } } }), "invoice_paid", "push"), true);
    for (const k of NOTIFICATION_KINDS) if (cellAvailable(k, "push") && k !== "alert_fired" && k !== "invite_accepted") assert.ok((PUSH_KINDS as readonly string[]).includes(k), `${k} is a push kind`);
  });

  it("a muted kind goes nowhere; a channel switch turns its whole column off", () => {
    const muted = base({ mutedKinds: ["mention"], webPush: true, emailDigest: "daily", slack: true });
    for (const c of NOTIFICATION_CHANNELS) assert.equal(channelAllows(muted, "mention", c), false, c);
    const noBell = base({ inApp: false });
    assert.equal(channelOn(noBell, "push"), false, "phone push follows the bell");
    assert.equal(channelAllows(noBell, "approval_needed", "push"), false);
    const noPush = base({ push: false });
    assert.equal(channelAllows(noPush, "approval_needed", "push"), false);
  });

  it("opt-in channels follow the per-kind cell", () => {
    const p = base({ emailDigest: "daily", slack: true, webPush: true });
    assert.equal(channelAllows(p, "approval_needed", "email"), true);
    assert.equal(channelAllows(p, "invite_accepted", "slack"), false, "default cell off");
    assert.equal(channelAllows(base({ slack: true, channels: { invite_accepted: { slack: true } } }), "invite_accepted", "slack"), true);
    assert.equal(channelAllows(base({ slack: true, channels: { approval_needed: { slack: false } } }), "approval_needed", "slack"), false);
    assert.equal(channelAllows(p, "run_finished", "webPush"), true);
  });

  it("fixed cells can't be turned on (alerts and invites never reach the phone)", () => {
    assert.equal(cellAvailable("alert_fired", "push"), false);
    assert.equal(channelAllows(base({ channels: { alert_fired: { push: true } } }), "alert_fired", "push"), false);
  });

  it("an old stored row (before 18.3) still reads, with the new fields defaulted", () => {
    const p = coercePreferences({ notifications: { inApp: true, push: false, mutedKinds: ["mention"] } }).notifications;
    assert.equal(p.push, false);
    assert.deepEqual(p.mutedKinds, ["mention"]);
    assert.equal(p.emailDigest, "off");
    assert.deepEqual(p.channels, {});
  });
});

describe("email digest assembly", () => {
  it("one email, grouped by workspace, newest first, with absolute links and the agent summary", () => {
    const d = assembleDigest(
      [
        { workspaceName: "Acme", items: [
          { kind: "mention", title: "Ana mentioned you", body: "Look at this", href: "/dashboard/messages?m=1", createdAt: new Date("2026-10-06T08:00:00Z") },
          { kind: "approval_needed", title: "Ad spend needs your approval", body: null, href: "/dashboard/approvals", createdAt: new Date("2026-10-06T09:00:00Z") },
        ] },
        { workspaceName: "Empty", items: [] },
      ],
      { appUrl: "https://app.example.com/", summary: "Two things happened." },
    );
    assert.equal(d.count, 2);
    assert.equal(d.title, "2 unread notifications in ShapesOS");
    assert.ok(d.body.indexOf("Ad spend") < d.body.indexOf("Ana mentioned"), "newest first");
    assert.match(d.body, /https:\/\/app\.example\.com\/dashboard\/approvals/);
    assert.match(d.body, /^What happened \(written by your lead agent\):\nTwo things happened\./);
    assert.ok(!d.body.includes("Empty"));
    assert.equal(d.links?.[0]?.url, "https://app.example.com/dashboard/notifications");
  });

  it("the summary prompt uses only the facts given", () => {
    const p = buildSummaryPrompt({ memberName: "Ana Ruiz", workspaceName: "Acme", day: "2026-10-06", counts: { mention: 2, approval_needed: 0 }, items: ["(unread) Ana mentioned you"] });
    assert.match(p, /Use ONLY the notifications below/);
    assert.match(p, /Member: Ana\n/);
    assert.match(p, /mention: 2/);
    assert.ok(!p.includes("approval needed: 0"));
  });
});

describe("producer seams", () => {
  it("ops writes: invoice paid once, ticket assignment on change only", () => {
    assert.deepEqual(opsNotices("invoices", { id: "i1", status: "sent" }, { id: "i1", status: "paid", number: "INV-1", totalCents: 1200 }).map((n) => n.kind), ["invoice_paid"]);
    assert.deepEqual(opsNotices("invoices", { id: "i1", status: "paid" }, { id: "i1", status: "paid" }), [], "already paid");
    assert.deepEqual(opsNotices("invoices", null, { id: "c1", status: "paid", kind: "credit_note" }), [], "credit notes are not payments");
    const created = opsNotices("tickets", null, { id: "t1", number: 4, subject: "Help", assigneeId: "u2" });
    assert.equal(created[0]?.kind, "ticket_assigned");
    assert.deepEqual(opsNotices("tickets", { id: "t1", assigneeId: "u2" }, { id: "t1", assigneeId: "u2", status: "solved" }), [], "same assignee");
    assert.equal(opsNotices("tickets", { id: "t1", assigneeId: "u2" }, { id: "t1", assigneeId: "u3" })[0]?.kind, "ticket_assigned");
    assert.deepEqual(opsNotices("tickets", { id: "t1", assigneeId: "u2" }, { id: "t1", assigneeId: null }), [], "unassigned");
  });

  it("run finished: top-level runs a person started; quick chat turns stay quiet", () => {
    const t0 = new Date("2026-10-06T10:00:00Z");
    assert.equal(runFinishedWorthNotifying({ workspaceId: "w", runId: "r", kind: "mission", startedBy: "u1" }), true);
    assert.equal(runFinishedWorthNotifying({ workspaceId: "w", runId: "r", kind: "mission", startedBy: "u1", parentRunId: "p" }), false);
    assert.equal(runFinishedWorthNotifying({ workspaceId: "w", runId: "r", kind: "playbook", startedBy: "scheduler" }), false);
    assert.equal(runFinishedWorthNotifying({ workspaceId: "w", runId: "r", kind: "chat", startedBy: "u1", createdAt: t0, endedAt: new Date(t0.getTime() + 30_000) }), false);
    assert.equal(runFinishedWorthNotifying({ workspaceId: "w", runId: "r", kind: "chat", startedBy: "u1", createdAt: t0, endedAt: new Date(t0.getTime() + 5 * 60_000) }), true);
  });

  it("meetings: only timed events starting in the next ten minutes", () => {
    const now = new Date("2026-10-06T10:00:00Z");
    const ev = (id: string, start: string, allDay = false) => ({ id, source: "google", title: id, start, end: null, allDay, location: null, attendees: [], href: null, externalUrl: null, editable: false, connectionId: null, externalId: null, mock: false }) as CalendarEvent;
    const got = startingSoon([ev("a", "2026-10-06T10:05:00Z"), ev("b", "2026-10-06T10:10:00Z"), ev("c", "2026-10-06T09:59:00Z"), ev("d", "2026-10-06T10:01:00Z", true)], now).map((e) => e.id);
    assert.deepEqual(got, ["a"]);
  });
});

describe("Slack delivery (STUB — no Slack here)", () => {
  it("the DM text links back to the app", () => {
    assert.equal(slackText({ title: "Ticket #4 was assigned to you", body: "Help", href: "/dashboard/ops/helpdesk?ticket=t1" }, "https://app.example.com"), "*Ticket #4 was assigned to you*\nHelp\n<https://app.example.com/dashboard/ops/helpdesk?ticket=t1|Open in ShapesOS>");
  });

  it("only when the workspace has the Slack app and the person is mapped", async () => {
    const sent: Array<{ email: string; text: string }> = [];
    const deps = {
      installation: async (ws: string) => (ws === "with-slack" ? { connectionId: "conn1" } : null),
      emailOf: async (_ws: string, userId: string) => (userId === "u-unmapped" ? null : `${userId}@example.com`),
      sendDm: async (_c: string, email: string, text: string) => {
        if (email.startsWith("u-notinslack")) return false;
        sent.push({ email, text });
        return true;
      },
      appUrl: () => null,
    };
    const note = (workspaceId: string, userId: string) => ({ workspaceId, userId, kind: "mention" as const, title: `hi ${userId}` });
    const r = await deliverSlack([note("with-slack", "u1"), note("no-slack", "u2"), note("with-slack", "u-unmapped"), note("with-slack", "u-notinslack")], deps);
    assert.deepEqual(r, { sent: 1, skipped: 3 });
    assert.deepEqual(sent.map((s) => s.email), ["u1@example.com"]);
  });
});
