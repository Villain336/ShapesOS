// ShapesOS — Phase 10 (portal): the client portal on real Postgres, as the
// least-privilege app role (FORCE RLS applies).
//   - sign-in: same answer for unknown / portal-off / known addresses; one
//     link per portal-enabled client (across workspaces); the shared
//     per-address send limit; links single use, expiring, bound to the
//     client's current sign-in email; sessions revocable (sign out, portal
//     off, email change)
//   - scoping: client A never sees client B's invoices, quotes, tickets or
//     projects in the SAME workspace; drafts, internal notes, failed replies
//     and internal tasks never show
//   - quote accept/decline lands exactly once (concurrent decisions), audited
//     as client:<id>; ticket open + replies thread (re-open, closed refuses)
//   - routes: portalGuard (cookie, CSRF, viewerRole), PDFs, cookie paths
// Mail is captured through the sendAuthEmail test seam (deps.deliver) — no
// real mail is sent.
// Run: DATABASE_URL=<app role url> npx tsx --test lib/portal/__tests__/portal-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createTicket, addTicketNote } from "@/lib/ops/helpdesk";
import { updateClient } from "@/lib/workspace/clients";
import { EMAIL_SEND_LIMIT } from "@/lib/auth/email/tokens";
import { PORTAL_LINK_SENT, consumePortalLink, requestPortalLink, resolvePortalSession, revokePortalSessions, type PortalPrincipal } from "../store";
import {
  createPortalTicket,
  decidePortalQuote,
  getPortalProject,
  getPortalTicket,
  listPortalDocuments,
  listPortalInvoices,
  listPortalProjects,
  listPortalQuotes,
  listPortalTickets,
  portalInvoicePdf,
  replyPortalTicket,
} from "../data";
import { updateClientPortal } from "../admin";
import { PORTAL_COOKIE, mintPortalToken } from "../core";
import { POST as linkPOST } from "@/app/api/portal/link/route";
import { POST as logoutPOST } from "@/app/api/portal/logout/route";
import { POST as ticketsPOST } from "@/app/api/portal/tickets/route";
import { POST as decisionPOST } from "@/app/api/portal/quotes/[id]/decision/route";
import { GET as invoicePdfGET } from "@/app/api/portal/invoices/[id]/pdf/route";

const tag = randomUUID().replace(/-/g, "").slice(0, 10);
const WS = `portalws${tag}`;
const WS_B = `portalwsb${tag}`;
const mail = (n: string) => `${n}.${tag}@client.test`;
const ENV = { NODE_ENV: "test", APP_URL: "http://portal.test" } as unknown as NodeJS.ProcessEnv;
let ipN = 1;
const ip = () => `198.51.100.${ipN++ % 250}`;

const sent: Array<{ to: string; text: string }> = [];
const deps = { env: ENV, deliver: async (_via: string, m: { to: string; text: string }) => void sent.push({ to: m.to, text: m.text }) };
const tokenFrom = (text: string) => decodeURIComponent(/#token=([^\s]+)/.exec(text)![1]!);

const ids = {} as Record<string, string>;
const inWs = <T>(fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(WS, fn);

/** Simulate the 15-minute send window passing for this run's addresses. */
const resetSendBudget = () => prisma.emailAuthToken.deleteMany({ where: { email: { endsWith: `.${tag}@client.test` } } });

async function signIn(email: string, workspaceId = WS): Promise<{ token: string; p: PortalPrincipal }> {
  await resetSendBudget();
  sent.length = 0;
  await requestPortalLink({ email, ip: ip() }, deps);
  const m = sent.find((s) => tokenFrom(s.text).startsWith(`pl_${workspaceId}_`));
  assert.ok(m, `a link for ${email} in ${workspaceId}`);
  const r = await consumePortalLink(tokenFrom(m.text), { ip: ip() });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") throw new Error("unreachable");
  const p = await resolvePortalSession(r.sessionToken);
  assert.ok(p);
  return { token: r.sessionToken, p };
}

function portalReq(path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://portal.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json", origin: "http://portal.test" }),
      ...(token ? { cookie: `${PORTAL_COOKIE}=${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

before(async () => {
  for (const id of [WS, WS_B]) {
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${`Agency ${id}`}, ${"test:" + id}, now()) ON CONFLICT DO NOTHING`;
  }
  const stages = [{ id: "new", label: "New" }];
  const pipe = await prisma.pipeline.create({ data: { workspaceId: WS, name: "Sales", stages, isDefault: true } });
  const pipeB = await prisma.pipeline.create({ data: { workspaceId: WS_B, name: "Sales", stages, isDefault: true } });
  for (const [k, ws, pid] of [["leadA", WS, pipe.id], ["leadB", WS, pipe.id], ["leadX", WS_B, pipeB.id]] as const) {
    ids[k] = (await prisma.lead.create({ data: { workspaceId: ws, pipelineId: pid, name: k, email: mail(k), stage: "new" } })).id;
  }
  await inWs(async (tx) => {
    ids.contactA = (await tx.opsContact.create({ data: { workspaceId: WS, name: "Ana", email: mail("ana"), leadId: ids.leadA } })).id;
    ids.contactB = (await tx.opsContact.create({ data: { workspaceId: WS, name: "Bo", email: mail("bo"), leadId: ids.leadB } })).id;
    const line = [{ description: "Work", qty: 1, priceCents: 1000 }];
    const inv = (customerId: string, status: "sent" | "draft", number: string | null) =>
      tx.opsInvoice.create({ data: { workspaceId: WS, customerId, lineItems: line, totalCents: 1000, status, number, sentAt: status === "sent" ? new Date() : null } });
    ids.invA = (await inv(ids.leadA!, "sent", `INV-A${tag}`)).id;
    ids.invADraft = (await inv(ids.leadA!, "draft", null)).id;
    ids.invB = (await inv(ids.leadB!, "sent", `INV-B${tag}`)).id;
    const quote = (customerId: string, validUntil: Date | null, n: string) =>
      tx.opsQuote.create({ data: { workspaceId: WS, customerId, lineItems: line, subtotalCents: 1000, totalCents: 1000, status: "sent", number: n, sentAt: new Date(), validUntil } });
    ids.quoteA = (await quote(ids.leadA!, null, `QUO-A${tag}`)).id;
    ids.quoteAExpired = (await quote(ids.leadA!, new Date(Date.now() - 86_400_000), `QUO-E${tag}`)).id;
    ids.quoteB = (await quote(ids.leadB!, null, `QUO-B${tag}`)).id;
    const staff = { workspaceId: WS, userId: `staff_${tag}` };
    const tA = await createTicket(tx, staff, { subject: "Printer", contactId: ids.contactA, requesterEmail: mail("ana") });
    ids.ticketA = tA.id;
    await addTicketNote(tx, staff, tA.id, "INTERNAL: customer is grumpy");
    await tx.opsTicketMessage.create({ data: { workspaceId: WS, ticketId: tA.id, direction: "outbound", authorUserId: staff.userId, body: "We are on it.", deliveryStatus: "sent" } });
    await tx.opsTicketMessage.create({ data: { workspaceId: WS, ticketId: tA.id, direction: "outbound", authorUserId: staff.userId, body: "FAILED SEND", deliveryStatus: "failed" } });
    ids.ticketB = (await createTicket(tx, staff, { subject: "Bo's issue", contactId: ids.contactB, requesterEmail: mail("bo") })).id;
    const proj = await tx.opsProject.create({ data: { workspaceId: WS, customerId: ids.leadA, name: "Website", status: "active", milestones: [{ title: "Kickoff", status: "done" }, { title: "Launch", status: "pending" }] } });
    ids.projectA = proj.id;
    await tx.opsTask.create({ data: { workspaceId: WS, projectId: proj.id, title: "Design review", clientVisible: true } });
    await tx.opsTask.create({ data: { workspaceId: WS, projectId: proj.id, title: "INTERNAL margin check", clientVisible: false } });
    ids.projectB = (await tx.opsProject.create({ data: { workspaceId: WS, customerId: ids.leadB, name: "B's app", status: "active" } })).id;
  });
  const client = (workspaceId: string, name: string, loginEmail: string, viewerRole: "viewer" | "editor" | "admin", portalEnabled: boolean, links: { contactIds?: string[]; leadIds?: string[] }) =>
    prisma.client.create({ data: { workspaceId, name, loginEmail, viewerRole, portalEnabled, portalContactIds: links.contactIds ?? [], portalLeadIds: links.leadIds ?? [] } });
  ids.clientA = (await client(WS, "Ana Co", mail("ana"), "admin", true, { contactIds: [ids.contactA!] })).id;
  ids.clientB = (await client(WS, "Bo Co", mail("bo"), "editor", true, { contactIds: [ids.contactB!] })).id;
  ids.clientV = (await client(WS, "Viewer Co", mail("vi"), "viewer", true, { leadIds: [ids.leadA!], contactIds: [ids.contactA!] })).id;
  ids.clientOff = (await client(WS, "Off Co", mail("off"), "admin", false, {})).id;
  ids.clientE = (await client(WS, "Email Co", mail("ed"), "editor", true, {})).id;
  ids.clientL = (await client(WS, "Limit Co", mail("lim"), "editor", true, {})).id;
  ids.clientA2 = (await client(WS_B, "Ana in B", mail("ana"), "admin", true, { leadIds: [ids.leadX!] })).id;
});

after(async () => {
  await prisma.emailAuthToken.deleteMany({ where: { email: { endsWith: `.${tag}@client.test` } } });
  for (const id of [WS, WS_B]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$disconnect();
});

describe("portal sign-in (real Postgres, app role)", () => {
  it("same answer for unknown, portal-off and known addresses; links only to portal-enabled clients, one per workspace", async () => {
    sent.length = 0;
    const unknown = await requestPortalLink({ email: mail("nobody"), ip: ip() }, deps);
    const off = await requestPortalLink({ email: mail("off"), ip: ip() }, deps);
    assert.equal(sent.length, 0);
    const known = await requestPortalLink({ email: mail("ana").toUpperCase(), ip: ip() }, deps);
    assert.deepEqual([unknown, off, known], [{ ok: true, message: PORTAL_LINK_SENT }, { ok: true, message: PORTAL_LINK_SENT }, { ok: true, message: PORTAL_LINK_SENT }]);
    assert.equal(sent.length, 2, "Ana is a portal client of two workspaces");
    const prefixes = sent.map((s) => tokenFrom(s.text).split("_").slice(0, 2).join("_")).sort();
    assert.deepEqual(prefixes, [`pl_${WS}`, `pl_${WS_B}`].sort());
    for (const s of sent) {
      assert.equal(s.to, mail("ana"));
      assert.match(s.text, /^Sign in to your client portal/);
      assert.match(s.text, /http:\/\/portal\.test\/portal\/link#token=pl_/);
    }
    // Only hashes at rest.
    const rows = await inWs((tx) => tx.portalLoginLink.findMany({ where: { workspaceId: WS, clientId: ids.clientA } }));
    assert.ok(rows.length >= 1);
    for (const r of rows) assert.match(r.tokenHash, /^[0-9a-f]{64}$/);
    assert.ok(!rows.some((r) => sent.some((s) => s.text.includes(r.tokenHash))));
  });

  it("the per-address send limit is shared with workspace sign-in mail", async () => {
    sent.length = 0;
    for (let i = 0; i < EMAIL_SEND_LIMIT + 2; i++) await requestPortalLink({ email: mail("lim"), ip: ip() }, deps);
    assert.equal(sent.length, EMAIL_SEND_LIMIT);
    assert.equal(await prisma.emailAuthToken.count({ where: { email: mail("lim"), usedAt: { not: null } } }), EMAIL_SEND_LIMIT, "each portal mail counted as a never-usable row");
  });

  it("a link works once, only before it expires, and only as a sign-in link", async () => {
    sent.length = 0;
    await requestPortalLink({ email: mail("bo"), ip: ip() }, deps);
    const link = tokenFrom(sent[0]!.text);
    const expired = await consumePortalLink(link, { ip: ip(), now: new Date(Date.now() + 16 * 60_000) });
    assert.equal(expired.status, "invalid", "16 minutes later");
    const ok = await consumePortalLink(link, { ip: ip() });
    assert.equal(ok.status, "ok");
    assert.equal((await consumePortalLink(link, { ip: ip() })).status, "invalid", "second use");
    // Forged: a well-formed token naming this workspace that was never issued.
    assert.equal((await consumePortalLink(mintPortalToken("link", WS).raw, { ip: ip() })).status, "invalid");
    // A session token is not a link, and a link is not a session.
    if (ok.status === "ok") assert.equal((await consumePortalLink(ok.sessionToken, { ip: ip() })).status, "invalid");
    assert.equal(await resolvePortalSession(link), null);
    // The tampered workspace part changes the hash: no match in either scope.
    const swapped = link.replace(`pl_${WS}_`, `pl_${WS_B}_`);
    assert.equal((await consumePortalLink(swapped, { ip: ip() })).status, "invalid");
  });

  it("a session names its own workspace; the same email in another workspace is a different session", async () => {
    const a = await signIn(mail("ana"), WS);
    const a2 = await signIn(mail("ana"), WS_B);
    assert.equal(a.p.workspaceId, WS);
    assert.equal(a.p.clientId, ids.clientA);
    assert.equal(a2.p.workspaceId, WS_B);
    assert.equal(a2.p.clientId, ids.clientA2);
    // Workspace B's session can't see A's invoices, and vice versa.
    assert.deepEqual((await listPortalInvoices(a2.p)).invoices, []);
  });

  it("revoked, expired and portal-off sessions are denied", async () => {
    const s1 = await signIn(mail("bo"));
    assert.equal(await revokePortalSessions(WS, ids.clientB!, "client", { sessionId: s1.p.sessionId }), 1);
    assert.equal(await resolvePortalSession(s1.token), null, "signed out");
    const s2 = await signIn(mail("bo"));
    assert.equal(await resolvePortalSession(s2.token, new Date(Date.now() + 8 * 86_400_000)), null, "expired after 7 days");
    await updateClientPortal(WS, `admin_${tag}`, ids.clientB!, { portalEnabled: false });
    assert.equal(await resolvePortalSession(s2.token), null, "portal turned off revokes");
    const row = await inWs((tx) => tx.portalSession.findFirst({ where: { workspaceId: WS, id: s2.p.sessionId } }));
    assert.equal(row?.revokedBy, `admin_${tag}`);
    sent.length = 0;
    await requestPortalLink({ email: mail("bo"), ip: ip() }, deps);
    assert.equal(sent.length, 0, "no links while the portal is off");
    await updateClientPortal(WS, `admin_${tag}`, ids.clientB!, { portalEnabled: true });
  });

  it("changing the client's sign-in email ends sessions and voids outstanding links", async () => {
    const s = await signIn(mail("ed"));
    sent.length = 0;
    await requestPortalLink({ email: mail("ed"), ip: ip() }, deps);
    const pending = tokenFrom(sent[0]!.text);
    await updateClient(WS, `admin_${tag}`, ids.clientE!, { loginEmail: mail("ed2") });
    assert.equal(await resolvePortalSession(s.token), null);
    assert.equal((await consumePortalLink(pending, { ip: ip() })).status, "invalid");
  });

  it("portal tables are FORCE RLS: no rows without the GUC, none across workspaces", async () => {
    const none = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM portal_sessions WHERE workspace_id = ${WS}`;
    assert.equal(Number(none[0]!.n), 0);
    const cross = await withWorkspaceScope(WS_B, (tx) => tx.portalSession.count({ where: { workspaceId: WS } }));
    assert.equal(cross, 0);
    const own = await withWorkspaceScope(WS, (tx) => tx.portalSession.count({ where: { workspaceId: WS } }));
    assert.ok(own > 0);
  });
});

describe("portal scoping: client A vs client B in the same workspace", () => {
  let A: PortalPrincipal;
  let B: PortalPrincipal;
  let V: PortalPrincipal;
  before(async () => {
    A = (await signIn(mail("ana"))).p;
    B = (await signIn(mail("bo"))).p;
    V = (await signIn(mail("vi"))).p;
  });

  it("invoices: only the client's own, issued ones (never drafts)", async () => {
    assert.deepEqual((await listPortalInvoices(A)).invoices.map((i) => i.id), [ids.invA]);
    assert.deepEqual((await listPortalInvoices(B)).invoices.map((i) => i.id), [ids.invB]);
    await assert.rejects(portalInvoicePdf(A, ids.invB!), { status: 404 });
    await assert.rejects(portalInvoicePdf(A, ids.invADraft!), { status: 404 });
    const inv = (await listPortalInvoices(A)).invoices[0]!;
    assert.equal(inv.balanceCents, 1000);
    assert.equal(inv.payable, false, "no Stripe key: nothing is payable online");
  });

  it("quotes: only the client's own", async () => {
    assert.deepEqual((await listPortalQuotes(A)).quotes.map((q) => q.id).sort(), [ids.quoteA, ids.quoteAExpired].sort());
    assert.deepEqual((await listPortalQuotes(B)).quotes.map((q) => q.id), [ids.quoteB]);
    await assert.rejects(decidePortalQuote(B, ids.quoteA!, "accept"), { status: 404 });
  });

  it("tickets: only the client's own; internal notes and failed replies never show", async () => {
    assert.deepEqual((await listPortalTickets(A)).tickets.map((t) => t.id), [ids.ticketA]);
    assert.deepEqual((await listPortalTickets(B)).tickets.map((t) => t.id), [ids.ticketB]);
    await assert.rejects(getPortalTicket(A, ids.ticketB!), { status: 404 });
    await assert.rejects(replyPortalTicket(B, ids.ticketA!, { body: "hi" }), { status: 404 });
    const t = await getPortalTicket(A, ids.ticketA!);
    const bodies = t.messages.map((m) => m.body);
    assert.deepEqual(bodies, ["We are on it."]);
    assert.ok(!bodies.some((b) => /INTERNAL|FAILED/.test(b)));
  });

  it("projects: milestones and client-visible tasks only; other clients get 404", async () => {
    assert.deepEqual((await listPortalProjects(A)).map((p) => p.id), [ids.projectA]);
    assert.deepEqual((await listPortalProjects(B)).map((p) => p.id), [ids.projectB]);
    const p = await getPortalProject(V, ids.projectA!);
    assert.deepEqual(p.tasks.map((t) => t.title), ["Design review"]);
    assert.deepEqual(p.milestones.map((m) => m.title), ["Kickoff", "Launch"]);
    await assert.rejects(getPortalProject(B, ids.projectA!), { status: 404 });
  });

  it("a client with nothing linked sees nothing", async () => {
    const off = { ...A, links: { portalCompanyIds: [], portalContactIds: [], portalLeadIds: [] } };
    assert.deepEqual((await listPortalInvoices(off)).invoices, []);
    assert.deepEqual((await listPortalTickets(off)).tickets, []);
    assert.deepEqual(await listPortalProjects(off), []);
    const docs = await listPortalDocuments(off);
    assert.deepEqual([docs.reports, docs.signatures, docs.dataRooms], [[], [], []]);
  });

  it("quote accept vs decline at the same time: exactly one lands, audited as client:<id>", async () => {
    const results = await Promise.allSettled([decidePortalQuote(A, ids.quoteA!, "accept"), decidePortalQuote(A, ids.quoteA!, "decline")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(failed.length, 1);
    assert.equal((failed[0]!.reason as { status?: number }).status, 409);
    const winner = (ok[0] as PromiseFulfilledResult<{ status: string }>).value.status;
    const q = await inWs((tx) => tx.opsQuote.findFirst({ where: { workspaceId: WS, id: ids.quoteA } }));
    assert.equal(q?.status, winner);
    assert.ok(q?.decidedAt);
    await assert.rejects(decidePortalQuote(A, ids.quoteA!, "accept"), { status: 409 }, "already decided");
    await assert.rejects(decidePortalQuote(A, ids.quoteAExpired!, "accept"), { status: 409 }, "expired by date");
    const audit = await inWs((tx) => tx.opsAuditEvent.findMany({ where: { workspaceId: WS, entity: "quotes", entityId: ids.quoteA } }));
    assert.ok(audit.length >= 2);
    assert.ok(audit.every((a) => a.actor === `client:${ids.clientA}`));
  });

  it("open a ticket and reply: messages thread, a reply re-opens a solved ticket, closed refuses", async () => {
    const { id, number } = await createPortalTicket(A, { subject: "  New logo  ", body: "Please update the logo." });
    assert.ok(number > 0);
    const row = await inWs((tx) => tx.opsTicket.findFirst({ where: { workspaceId: WS, id } }));
    assert.equal(row?.contactId, ids.contactA);
    assert.equal(row?.requesterEmail, mail("ana"));
    assert.equal(row?.channel, "web");
    assert.equal(row?.createdBy, `client:${ids.clientA}`);
    await replyPortalTicket(A, id, { body: "Attached the SVG." });
    const msgs = await inWs((tx) => tx.opsTicketMessage.findMany({ where: { workspaceId: WS, ticketId: id }, orderBy: { createdAt: "asc" } }));
    assert.deepEqual(msgs.map((m) => [m.direction, m.fromEmail, m.authorUserId]), [
      ["inbound", mail("ana"), null],
      ["inbound", mail("ana"), null],
    ]);
    assert.deepEqual((await getPortalTicket(A, id)).messages.map((m) => m.fromClient), [true, true]);
    await inWs((tx) => tx.opsTicket.update({ where: { id, workspaceId: WS }, data: { status: "solved", solvedAt: new Date() } }));
    await replyPortalTicket(A, id, { body: "Actually one more thing." });
    assert.equal((await inWs((tx) => tx.opsTicket.findFirst({ where: { workspaceId: WS, id } })))?.status, "open");
    await inWs((tx) => tx.opsTicket.update({ where: { id, workspaceId: WS }, data: { status: "closed" } }));
    await assert.rejects(replyPortalTicket(A, id, { body: "hello?" }), { status: 409 });
    await assert.rejects(createPortalTicket(A, { subject: "", body: "x" }), { status: 400 });
    const noContact = { ...A, links: { portalCompanyIds: [], portalContactIds: [], portalLeadIds: [ids.leadA!] } };
    await assert.rejects(createPortalTicket(noContact, { subject: "x", body: "y" }), { status: 422 });
  });
});

describe("portal routes", () => {
  let tokA = "";
  let tokB = "";
  let tokV = "";
  before(async () => {
    tokA = (await signIn(mail("ana"))).token;
    tokB = (await signIn(mail("bo"))).token;
    tokV = (await signIn(mail("vi"))).token;
  });

  it("/api/portal/link sets the session cookie on /portal and /api/portal only", async () => {
    sent.length = 0;
    await requestPortalLink({ email: mail("bo"), ip: ip() }, deps);
    const res = await linkPOST(portalReq("/api/portal/link", null, { token: tokenFrom(sent[0]!.text) }));
    assert.equal(res.status, 200);
    const cookies = res.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.match(cookies[0]!, /^shapes_portal=ps_.*; Path=\/portal; HttpOnly; SameSite=Lax/);
    assert.match(cookies[1]!, /^shapes_portal=ps_.*; Path=\/api\/portal; HttpOnly; SameSite=Lax/);
    const again = await linkPOST(portalReq("/api/portal/link", null, { token: tokenFrom(sent[0]!.text) }));
    assert.equal(again.status, 400);
    const crossSite = await linkPOST(portalReq("/api/portal/link", null, { token: "x" }, { origin: "https://evil.test" }));
    assert.equal(crossSite.status, 403);
  });

  it("portalGuard: no cookie 401, foreign Origin 403, workspace cookie alone 401", async () => {
    assert.equal((await ticketsPOST(portalReq("/api/portal/tickets", null, { subject: "s", body: "b" }))).status, 401);
    assert.equal((await ticketsPOST(portalReq("/api/portal/tickets", tokA, { subject: "s", body: "b" }, { origin: "https://evil.test" }))).status, 403);
    const noOrigin = new Request("http://portal.test/api/portal/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${PORTAL_COOKIE}=${tokA}` },
      body: JSON.stringify({ subject: "s", body: "b" }),
    });
    assert.equal((await ticketsPOST(noOrigin)).status, 403);
    // The portal token under the Auth.js cookie name is not a portal session either.
    assert.equal((await ticketsPOST(portalReq("/api/portal/tickets", null, { subject: "s", body: "b" }, { cookie: `authjs.session-token=${tokA}` }))).status, 401);
  });

  it("viewerRole gates actions: viewer can't open tickets, editor can't decide quotes", async () => {
    assert.equal((await ticketsPOST(portalReq("/api/portal/tickets", tokV, { subject: "s", body: "b" }))).status, 403);
    const okRes = await ticketsPOST(portalReq("/api/portal/tickets", tokB, { subject: "From route", body: "Hello" }));
    assert.equal(okRes.status, 201);
    assert.equal((await decisionPOST(portalReq(`/api/portal/quotes/${ids.quoteB}/decision`, tokB, { decision: "accept" }), params(ids.quoteB!))).status, 403);
    assert.equal((await decisionPOST(portalReq(`/api/portal/quotes/${ids.quoteB}/decision`, tokA, { decision: "accept" }), params(ids.quoteB!))).status, 404, "admin of another client: not in scope");
    assert.equal((await decisionPOST(portalReq(`/api/portal/quotes/${ids.quoteB}/decision`, tokA, { decision: "maybe" }), params(ids.quoteB!))).status, 400);
  });

  it("invoice PDF: the finance renderer for your own invoice, 404 for anyone else's", async () => {
    const mine = await invoicePdfGET(portalReq(`/api/portal/invoices/${ids.invA}/pdf`, tokA), params(ids.invA!));
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await mine.arrayBuffer()).subarray(0, 4).toString(), "%PDF");
    assert.equal((await invoicePdfGET(portalReq(`/api/portal/invoices/${ids.invB}/pdf`, tokA), params(ids.invB!))).status, 404);
    assert.equal((await invoicePdfGET(portalReq(`/api/portal/invoices/${ids.invA}/pdf`, tokV), params(ids.invA!))).status, 403, "viewers don't see invoices");
  });

  it("logout revokes the session and clears both cookies", async () => {
    const res = await logoutPOST(portalReq("/api/portal/logout", tokA, {}));
    assert.equal(res.status, 200);
    const cookies = res.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    for (const c of cookies) assert.match(c, /^shapes_portal=; .*Max-Age=0$/);
    assert.equal(await resolvePortalSession(tokA), null);
    assert.equal((await ticketsPOST(portalReq("/api/portal/tickets", tokA, { subject: "s", body: "b" }))).status, 401);
  });
});
