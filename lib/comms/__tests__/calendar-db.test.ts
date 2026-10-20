// ShapesOS — Phase 18.2 (WS=comms) DB test: Calendar.
//   - the private ICS feed: a token resolves only in its own workspace, the
//     public route serves the member's own items (never a teammate's
//     reminders), revoking makes it 404 at once, and a member who left
//     loses it; the hash (never the token) is stored;
//   - the view reads the workspace's bookings (never another workspace's)
//     and the member's OWN calendar connections only (a teammate's mailbox /
//     calendar is never read for them); a mock connector's rows are labelled;
//   - find time works around busy bookings;
//   - an event create goes to the member's own calendar (the person's click
//     audited); the agent tool asks first (write_outlook_calendar, Tier 2).
// Real Postgres as the least-privilege app role (dev: labelled mock Outlook
// Calendar — no credential — nothing is sent anywhere).
// Run: DATABASE_URL=<app role> npx tsx --test lib/comms/__tests__/calendar-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ToolContext } from "@/lib/chat/tools";
import type { ChatToolCall } from "@/lib/chat/tool-exec";

const RUN = randomUUID().slice(0, 8);
const WS = `p182-cal-${RUN}`;
const OTHER = `p182-cal-x-${RUN}`;
const ANA = `p182-cal-ana-${RUN}`;
const BEN = `p182-cal-ben-${RUN}`;

let prisma: typeof import("@/lib/prisma").prisma;
let rls: typeof import("@/lib/substrate/memory/rls");
let feed: typeof import("../calendar/feed.server");
let sources: typeof import("../calendar/sources.server");
type Tx = import("@prisma/client").Prisma.TransactionClient;
const inWs = <T,>(ws: string, fn: (tx: Tx) => Promise<T>) => rls.withWorkspaceScope(ws, (tx) => fn(tx as Tx));

// Monday 10:00–11:00 UTC next week: a booking that makes the slot busy.
function nextMonday(h: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ((8 - now.getUTCDay()) % 7 || 7), h));
  return d;
}

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  rls = await import("@/lib/substrate/memory/rls");
  feed = await import("../calendar/feed.server");
  sources = await import("../calendar/sources.server");
  for (const ws of [WS, OTHER]) await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: ANA } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "owner" },
      { workspaceId: WS, userId: BEN, role: "editor" },
      { workspaceId: OTHER, userId: ANA, role: "owner" },
    ],
  });
  for (const [ws, title] of [
    [WS, `Demo ${RUN}`],
    [OTHER, `Other workspace ${RUN}`],
  ] as const) {
    const page = await prisma.bookingPage.create({ data: { workspaceId: ws, slug: `p182-${ws}`, tokenHash: `p182-${ws}-hash`, title } });
    await prisma.booking.create({ data: { workspaceId: ws, pageId: page.id, name: "Visitor", email: `v-${RUN}@example.com`, startAt: nextMonday(10), endAt: nextMonday(11) } });
  }
  await inWs(WS, async (tx) => {
    await tx.opsTask.create({ data: { workspaceId: WS, projectId: null, assigneeId: ANA, createdBy: ANA, title: `Ana's reminder ${RUN}`, dueAt: nextMonday(15) } });
    await tx.opsTask.create({ data: { workspaceId: WS, projectId: null, assigneeId: BEN, createdBy: BEN, title: `Ben's private reminder ${RUN}`, dueAt: nextMonday(15) } });
  });
  // A labelled MOCK Outlook Calendar for Ana (no credential) and a real-looking Google one for Ben.
  await prisma.connectorConnection.create({ data: { workspaceId: WS, connectorKey: "outlook-calendar", userId: ANA, status: "active", scopes: [], meta: { email: `ana-${RUN}@example.com` } } });
  await prisma.connectorConnection.create({ data: { workspaceId: WS, connectorKey: "google-calendar", userId: BEN, status: "active", scopes: [] } });
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, OTHER] } } });
  await prisma.$disconnect();
});

const ctxOf = (userId: string) => ({ workspaceId: WS, userId, timeZone: "UTC" });

describe("the view", () => {
  it("reads this workspace's bookings, the member's own reminders and only the member's own calendars", async () => {
    const from = new Date(nextMonday(0).getTime() - 86_400_000);
    const to = new Date(nextMonday(0).getTime() + 2 * 86_400_000);
    const ana = await sources.loadCalendarEvents(ctxOf(ANA), from, to);
    assert.ok(ana.events.some((e) => e.source === "booking" && e.title.startsWith(`Demo ${RUN}`)));
    assert.ok(!ana.events.some((e) => e.title.includes(`Other workspace ${RUN}`)), "never another workspace's bookings");
    assert.ok(ana.events.some((e) => e.source === "reminder" && e.title === `Ana's reminder ${RUN}`));
    assert.ok(!ana.events.some((e) => e.title.includes("Ben's private reminder")), "never a teammate's reminders");
    assert.deepEqual(ana.connections.map((c) => c.key), ["outlook-calendar"], "only Ana's own calendar connection");
    // The dev mock Outlook answers one fixed "(MOCK)" event on 2026-10-12.
    const mockWin = await sources.loadCalendarEvents(ctxOf(ANA), new Date("2026-10-11T00:00:00Z"), new Date("2026-10-14T00:00:00Z"), { include: ["outlook"] });
    const outlook = mockWin.events.filter((e) => e.source === "outlook");
    assert.ok(outlook.length >= 1, JSON.stringify(mockWin));
    for (const e of outlook) {
      assert.equal(e.mock, true, "dev: the labelled mock — flagged on every row");
      assert.equal(e.editable, false, "a mock row is never editable");
      assert.match(e.title, /MOCK/);
    }
    const ben = await sources.loadCalendarEvents(ctxOf(BEN), from, to);
    assert.deepEqual(ben.connections.map((c) => c.key), ["google-calendar"]);
    assert.ok(ben.errors.some((e) => e.source === "google-calendar"), "Google has no credential and no mock: shown as an error, not hidden");
  });

  it("find time avoids the busy booking", async () => {
    const { busyIntervals } = sources;
    const { findSlots } = await import("../calendar/freebusy");
    const from = nextMonday(0);
    const to = new Date(from.getTime() + 86_400_000);
    const { busy } = await busyIntervals(ctxOf(ANA), from, to);
    const slots = findSlots({ busy, from, to, durationMin: 60, timeZone: "UTC", max: 10 });
    assert.ok(slots.length > 0);
    for (const s of slots) assert.ok(s.end <= nextMonday(10) || s.start >= nextMonday(11), `${s.start.toISOString()} overlaps the booking`);
  });
});

describe("events go to the member's own calendar", () => {
  it("a person's create is audited; another member's connection is refused; the agent tool asks first", async () => {
    const { saveCalendarEvent } = await import("../calendar/write.server");
    const anaConn = await prisma.connectorConnection.findFirst({ where: { workspaceId: WS, userId: ANA } });
    const benConn = await prisma.connectorConnection.findFirst({ where: { workspaceId: WS, userId: BEN } });
    const out = await saveCalendarEvent({ workspaceId: WS, userId: ANA, connectionId: anaConn!.id, fields: { title: `Sync ${RUN}`, start: nextMonday(13).toISOString(), end: nextMonday(14).toISOString() }, by: "person" });
    assert.equal(out.mock, true, "dev mock: nothing was created anywhere");
    assert.equal(await prisma.fileChangeLog.count({ where: { workspaceId: WS, action: "calendar_event_saved" } }), 1);
    await assert.rejects(saveCalendarEvent({ workspaceId: WS, userId: ANA, connectionId: benConn!.id, fields: { title: "x", start: nextMonday(13).toISOString(), end: nextMonday(14).toISOString() }, by: "person" }), /not connected to your account/);

    const { executeTool } = await import("@/lib/chat/tool-exec");
    const ctx: ToolContext = { projectId: `p182-np-${RUN}`, workspaceId: WS, userId: ANA, role: "owner", confirmed: false, agentKey: "scheduler", grant: ["workspace", "calendar"] };
    const args = { title: `Agent sync ${RUN}`, start: nextMonday(16).toISOString(), end: nextMonday(17).toISOString() };
    const call: ChatToolCall = { tool: "calendar_create_event_outlook", args, status: "pending_confirmation" };
    await executeTool(ctx, call.tool, args, call);
    assert.equal(call.status, "pending_confirmation");
    assert.equal(call.autoAction, "write_outlook_calendar");
    const yes: ChatToolCall = { tool: "calendar_create_event_outlook", args, status: "pending_confirmation" };
    await executeTool({ ...ctx, confirmed: true }, yes.tool, args, yes);
    assert.equal(yes.status, "executed", yes.resultSummary);
    assert.match(yes.resultSummary ?? "", /MOCK/);
  });
});

describe("the private ICS feed", () => {
  it("serves the member's own items, 404s when revoked, in another workspace, malformed, or once they left", async () => {
    const { id, path } = await feed.createFeed(WS, ANA);
    const token = path.split("/").pop()!.replace(/\.ics$/, "");
    const row = await inWs(WS, (tx) => tx.calendarFeedToken.findUnique({ where: { id } }));
    assert.equal(row?.tokenHash, feed.hashFeedToken(token));
    assert.ok(!JSON.stringify(row).includes(token), "the token itself is never stored");

    const route = await import("@/app/api/comms/calendar/feed/[workspaceId]/[token]/route");
    const get = (ws: string, tok: string) => route.GET(new Request(`http://x/api/comms/calendar/feed/${ws}/${tok}.ics`) as never, { params: Promise.resolve({ workspaceId: ws, token: `${tok}.ics` }) });
    const ok = await get(WS, token);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /text\/calendar/);
    const body = await ok.text();
    assert.match(body, /BEGIN:VCALENDAR/);
    assert.ok(body.includes(`Ana's reminder ${RUN}`.replace(/,/g, "\\,")));
    assert.ok(!body.includes("Ben's private reminder"), "never a teammate's reminders");
    assert.ok(!body.includes(`Other workspace ${RUN}`));

    assert.equal((await get(OTHER, token)).status, 404, "the token belongs to its own workspace");
    assert.equal((await get(WS, "short")).status, 404);
    assert.equal((await get(WS, `${token.slice(0, -2)}xx`)).status, 404);

    await feed.revokeFeed(WS, ANA, id);
    assert.equal((await get(WS, token)).status, 404, "revoked → 404 at once");
    await assert.rejects(feed.revokeFeed(WS, BEN, id), /not found/i, "not Ben's to revoke");

    const second = await feed.createFeed(WS, BEN);
    const benToken = second.path.split("/").pop()!.replace(/\.ics$/, "");
    assert.equal((await get(WS, benToken)).status, 200);
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: WS, userId: BEN } });
    assert.equal((await get(WS, benToken)).status, 404, "a member who left loses the feed");
  });
});
