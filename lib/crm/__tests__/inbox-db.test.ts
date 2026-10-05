// ShapesOS — CRM conversation inbox (Phase 4b), against a real database.
//   - threads merge outbound + inbound ledger rows per lead, newest first
//   - per-user unread state (conversation_reads, FORCE RLS), only moves forward
//   - filters: channel, unread, assigned, q; cursor paging
//   - tenant isolation: another workspace's ledger and markers never leak
//   - routes: viewer reads + marks read; reply is editor+ and goes through the
//     dispatcher (consent → suppressed; opted in → queued behind an approval)
// DB-backed (scripts/test/db-tests.txt); run as the least-privilege app role.
// Run: DATABASE_URL=… npx tsx --test --experimental-test-module-mocks lib/crm/__tests__/inbox-db.test.ts

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listThreads, getThread, markThreadRead, markThreadUnread, type ThreadFilters } from "../inbox";

const tag = randomUUID().slice(0, 8);
const WS = `inbox-ws-${tag}`;
const WS2 = `inbox-ws2-${tag}`;
const EDITOR = `inbox-editor-${tag}`;
const VIEWER = `inbox-viewer-${tag}`;
let actor = { id: EDITOR, email: "editor@inbox.test" };

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
    getOrCreateWorkspace: async () => ({ id: WS, name: WS }),
  },
});

type ListRoute = typeof import("@/app/api/crm/inbox/threads/route");
type ThreadRoute = typeof import("@/app/api/crm/inbox/threads/[leadId]/route");
type ReadRoute = typeof import("@/app/api/crm/inbox/threads/[leadId]/read/route");
type ReplyRoute = typeof import("@/app/api/crm/inbox/threads/[leadId]/reply/route");
let listRoute: ListRoute;
let threadRoute: ThreadRoute;
let readRoute: ReadRoute;
let replyRoute: ReplyRoute;

const leads: Record<string, string> = {};
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000);

async function msg(
  workspaceId: string,
  leadId: string | null,
  channel: "sms" | "email",
  direction: "inbound" | "outbound",
  minute: number,
  body: string,
  extra: Record<string, unknown> = {},
) {
  return prisma.outboundMessage.create({
    data: {
      workspaceId,
      leadId,
      channel,
      direction,
      kind: "manual",
      body,
      status: direction === "inbound" ? "delivered" : "sent",
      createdAt: at(minute),
      ...extra,
    },
  });
}

const params = (leadId: string) => ({ params: Promise.resolve({ leadId }) });
const post = (body: unknown) =>
  new Request("http://x/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
const get = (url: string) => {
  const r = new Request(url) as Request & { nextUrl: URL };
  Object.defineProperty(r, "nextUrl", { value: new URL(url) });
  return r as never;
};

before(async () => {
  for (const id of [WS, WS2]) {
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
      VALUES (${id}, ${id}, ${"test:" + id}, now()) ON CONFLICT DO NOTHING`;
  }
  const member = (userId: string, role: WorkspaceRole) =>
    prisma.workspaceMember.create({ data: { workspaceId: WS, userId, role, email: `${userId}@inbox.test` } });
  await member(EDITOR, "editor");
  await member(VIEWER, "viewer");
  const pipe = await prisma.pipeline.create({ data: { workspaceId: WS, name: "Sales", stages: [{ id: "new", label: "New" }] } });
  const pipe2 = await prisma.pipeline.create({ data: { workspaceId: WS2, name: "Sales", stages: [{ id: "new", label: "New" }] } });
  const lead = async (key: string, data: Record<string, unknown>, ws = WS, pipelineId = pipe.id) => {
    const l = await prisma.lead.create({ data: { workspaceId: ws, pipelineId, name: key, ...data } });
    leads[key] = l.id;
  };
  await lead("Ada Lovelace", { phone: "+15550000001", email: "ada@example.test", ownerId: EDITOR });
  await lead("Grace Hopper", { phone: "+15550000002", email: "grace@example.test" });
  await lead("Alan Turing", { email: "alan@example.test", ownerId: VIEWER });
  await lead("Quiet Lead", { phone: "+15550000004" }); // no messages → no thread
  await lead("Other Tenant", { phone: "+15550000009" }, WS2, pipe2.id);

  // Ada: outbound sms, inbound reply (unread), outbound email.
  await msg(WS, leads["Ada Lovelace"]!, "sms", "outbound", 0, "Hi Ada, quick question");
  await msg(WS, leads["Ada Lovelace"]!, "sms", "inbound", 5, "Sure, call me");
  await msg(WS, leads["Ada Lovelace"]!, "email", "outbound", 10, "Proposal attached", { subject: "Your proposal" });
  // Grace: two inbound texts, newest overall.
  await msg(WS, leads["Grace Hopper"]!, "sms", "inbound", 20, "Is this still available?");
  await msg(WS, leads["Grace Hopper"]!, "sms", "inbound", 21, "Hello?");
  // Alan: outbound email only (no inbound → never unread).
  await msg(WS, leads["Alan Turing"]!, "email", "outbound", 15, "Welcome", { subject: "Welcome aboard" });
  // Unmatched inbound + another tenant's thread.
  await msg(WS, null, "sms", "inbound", 30, "wrong number");
  await msg(WS2, leads["Other Tenant"]!, "sms", "inbound", 40, "secret other tenant");

  listRoute = await import("@/app/api/crm/inbox/threads/route");
  threadRoute = await import("@/app/api/crm/inbox/threads/[leadId]/route");
  readRoute = await import("@/app/api/crm/inbox/threads/[leadId]/read/route");
  replyRoute = await import("@/app/api/crm/inbox/threads/[leadId]/reply/route");
});

after(async () => {
  for (const id of [WS, WS2]) {
    await withWorkspaceScope(id, (tx) => tx.conversationRead.deleteMany({ where: { workspaceId: id } })).catch(() => {});
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`.catch(() => {});
  }
  await prisma.$disconnect();
});

const list = (userId: string, filters: ThreadFilters = {}) =>
  withWorkspaceScope(WS, (tx) => listThreads(tx, { workspaceId: WS, userId, ...filters }));

describe("listThreads", () => {
  it("merges inbound + outbound per lead, newest activity first, tenant-scoped", async () => {
    const res = await list(EDITOR);
    assert.deepEqual(
      res.threads.map((t) => t.leadName),
      ["Grace Hopper", "Alan Turing", "Ada Lovelace"],
    );
    const ada = res.threads.find((t) => t.leadName === "Ada Lovelace")!;
    assert.equal(ada.messageCount, 3);
    assert.equal(ada.inboundCount, 1);
    assert.equal(ada.unreadCount, 1);
    assert.deepEqual(ada.channels, ["email", "sms"]);
    assert.equal(ada.lastDirection, "outbound");
    assert.equal(ada.lastChannel, "email");
    assert.equal(ada.lastSnippet, "Proposal attached");
    const grace = res.threads[0]!;
    assert.equal(grace.unreadCount, 2);
    assert.equal(res.unreadThreads, 2);
    assert.equal(res.unmatchedInbound, 1);
    assert.ok(!res.threads.some((t) => t.leadName === "Other Tenant" || t.leadName === "Quiet Lead"));
  });

  it("filters by channel, unread, assigned and search", async () => {
    assert.deepEqual(
      (await list(EDITOR, { channel: "email" })).threads.map((t) => t.leadName),
      ["Alan Turing", "Ada Lovelace"],
    );
    const sms = await list(EDITOR, { channel: "sms" });
    assert.equal(sms.threads.find((t) => t.leadName === "Ada Lovelace")?.messageCount, 2);
    assert.deepEqual(
      (await list(EDITOR, { unread: true })).threads.map((t) => t.leadName),
      ["Grace Hopper", "Ada Lovelace"],
    );
    assert.deepEqual((await list(EDITOR, { assigned: "me" })).threads.map((t) => t.leadName), ["Ada Lovelace"]);
    assert.deepEqual((await list(VIEWER, { assigned: "me" })).threads.map((t) => t.leadName), ["Alan Turing"]);
    assert.deepEqual((await list(EDITOR, { assigned: "unassigned" })).threads.map((t) => t.leadName), ["Grace Hopper"]);
    assert.deepEqual((await list(EDITOR, { q: "grace@" })).threads.map((t) => t.leadName), ["Grace Hopper"]);
    assert.deepEqual((await list(EDITOR, { q: "100%_" })).threads, []);
  });

  it("pages with a cursor", async () => {
    const p1 = await list(EDITOR, { limit: 2 });
    assert.equal(p1.threads.length, 2);
    assert.ok(p1.nextCursor);
    const p2 = await list(EDITOR, { limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(p2.threads.map((t) => t.leadName), ["Ada Lovelace"]);
    assert.equal(p2.nextCursor, null);
  });
});

describe("read state", () => {
  it("is per user, only moves forward, and can be reset", async () => {
    const ada = leads["Ada Lovelace"]!;
    await withWorkspaceScope(WS, (tx) => markThreadRead(tx, { workspaceId: WS, userId: EDITOR, leadId: ada }));
    let mine = await list(EDITOR);
    assert.equal(mine.threads.find((t) => t.leadId === ada)?.unreadCount, 0);
    assert.equal(mine.unreadThreads, 1);
    // The viewer's state is untouched.
    assert.equal((await list(VIEWER)).threads.find((t) => t.leadId === ada)?.unreadCount, 1);
    // A stale tab can't move the marker back.
    await withWorkspaceScope(WS, (tx) => markThreadRead(tx, { workspaceId: WS, userId: EDITOR, leadId: ada, at: at(1) }));
    mine = await list(EDITOR);
    assert.equal(mine.threads.find((t) => t.leadId === ada)?.unreadCount, 0);
    // A marker before the inbound message leaves it unread.
    await withWorkspaceScope(WS, (tx) => markThreadUnread(tx, { workspaceId: WS, userId: EDITOR, leadId: ada }));
    await withWorkspaceScope(WS, (tx) => markThreadRead(tx, { workspaceId: WS, userId: EDITOR, leadId: ada, at: at(1) }));
    assert.equal((await list(EDITOR)).threads.find((t) => t.leadId === ada)?.unreadCount, 1);
  });

  it("markers are FORCE-RLS: invisible without the workspace scope and to other tenants", async () => {
    const role = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (role[0]!.rolsuper || role[0]!.rolbypassrls) return; // proves nothing as a superuser
    const unscoped = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM conversation_reads`;
    assert.equal(unscoped[0]!.n, 0);
    const other = await withWorkspaceScope(WS2, (tx) => tx.conversationRead.count());
    assert.equal(other, 0);
  });

  it("refuses a lead from another workspace", async () => {
    await assert.rejects(
      withWorkspaceScope(WS, (tx) => markThreadRead(tx, { workspaceId: WS, userId: EDITOR, leadId: leads["Other Tenant"]! })),
      /not found/i,
    );
    await assert.rejects(
      withWorkspaceScope(WS, (tx) => getThread(tx, { workspaceId: WS, userId: EDITOR, leadId: leads["Other Tenant"]! })),
      /not found/i,
    );
  });
});

describe("getThread", () => {
  it("returns the lead's messages oldest first with the last email subject", async () => {
    const t = await withWorkspaceScope(WS, (tx) =>
      getThread(tx, { workspaceId: WS, userId: EDITOR, leadId: leads["Ada Lovelace"]! }),
    );
    assert.deepEqual(t.messages.map((m) => m.direction), ["outbound", "inbound", "outbound"]);
    assert.equal(t.lastEmailSubject, "Your proposal");
    assert.equal(t.lead.name, "Ada Lovelace");
  });
});

describe("inbox routes", () => {
  it("viewer can list, open and mark read", async () => {
    actor = { id: VIEWER, email: "viewer@inbox.test" };
    const res = await listRoute.GET(get("http://x/api/crm/inbox/threads?unread=1"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { threads: Array<{ leadName: string }> };
    assert.ok(body.threads.some((t) => t.leadName === "Grace Hopper"));
    const one = await threadRoute.GET(get(`http://x/api/crm/inbox/threads/${leads["Grace Hopper"]}`), params(leads["Grace Hopper"]!));
    assert.equal(one.status, 200);
    const detail = (await one.json()) as { thread: { messages: unknown[] }; consent: { sms: string } };
    assert.equal(detail.thread.messages.length, 2);
    assert.equal(detail.consent.sms, "unknown");
    const read = await readRoute.POST(post({}), params(leads["Grace Hopper"]!));
    assert.equal(read.status, 200);
    const other = await threadRoute.GET(get("http://x/api/x"), params(leads["Other Tenant"]!));
    assert.equal(other.status, 404);
  });

  it("viewer cannot reply; nothing is queued", async () => {
    actor = { id: VIEWER, email: "viewer@inbox.test" };
    const before = await prisma.outboundMessage.count({ where: { workspaceId: WS } });
    const res = await replyRoute.POST(post({ channel: "sms", body: "hi" }), params(leads["Grace Hopper"]!));
    assert.equal(res.status, 403);
    assert.equal(await prisma.outboundMessage.count({ where: { workspaceId: WS } }), before);
  });

  it("editor reply without consent is suppressed by the dispatcher (no approval created)", async () => {
    actor = { id: EDITOR, email: "editor@inbox.test" };
    const res = await replyRoute.POST(post({ channel: "sms", body: "Yes, still available" }), params(leads["Grace Hopper"]!));
    assert.equal(res.status, 201);
    const body = (await res.json()) as { outcome: string; message: { suppressionReason: string; direction: string } };
    assert.equal(body.outcome, "suppressed");
    assert.equal(body.message.suppressionReason, "no_consent");
    assert.equal(body.message.direction, "outbound");
  });

  it("editor reply with consent queues behind a pending approval requested by the editor", async () => {
    actor = { id: EDITOR, email: "editor@inbox.test" };
    const leadId = leads["Grace Hopper"]!;
    await prisma.contactConsent.create({
      data: { workspaceId: WS, leadId, channel: "sms", status: "opted_in", consentedAt: new Date() },
    });
    const res = await replyRoute.POST(post({ channel: "sms", body: "Yes — want to book a call?" }), params(leadId));
    assert.equal(res.status, 201);
    const body = (await res.json()) as { outcome: string; message: { id: string; approvalId: string; status: string } };
    assert.equal(body.outcome, "queued");
    assert.equal(body.message.status, "queued");
    const approval = await prisma.approvalItem.findFirst({ where: { id: body.message.approvalId, workspaceId: WS } });
    assert.equal(approval?.status, "pending");
    assert.equal(approval?.requestedBy, EDITOR);
    // Replying marks the thread read for the replier.
    const t = (await list(EDITOR)).threads.find((x) => x.leadId === leadId)!;
    assert.equal(t.unreadCount, 0);
    assert.equal(t.lastDirection, "outbound");
  });

  it("validates the draft and the lead's contact details", async () => {
    actor = { id: EDITOR, email: "editor@inbox.test" };
    const noSubject = await replyRoute.POST(post({ channel: "email", body: "hi" }), params(leads["Alan Turing"]!));
    assert.equal(noSubject.status, 400);
    const noPhone = await replyRoute.POST(post({ channel: "sms", body: "hi" }), params(leads["Alan Turing"]!));
    assert.equal(noPhone.status, 400);
    const otherTenant = await replyRoute.POST(post({ channel: "sms", body: "hi" }), params(leads["Other Tenant"]!));
    assert.equal(otherTenant.status, 404);
  });
});
