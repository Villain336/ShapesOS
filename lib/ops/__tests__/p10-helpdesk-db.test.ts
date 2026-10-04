// ShapesOS Phase 10 (ops-core): helpdesk on real Postgres — inbound email
// through the EXISTING signed route opens / threads tickets (idempotent),
// replies record delivery and stamp the first response, the SLA sweep
// records a breach once, and the three tables are RLS-isolated.
// Email body fetch is MOCKED (Resend receiving API) and the reply provider
// is a labelled stub — no live mail is sent.
// Run as the app role (scripts/test/db-tests.txt):
//   DATABASE_URL=<app role url> npx tsx --test lib/ops/__tests__/p10-helpdesk-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { supportAddressFor, RESEND_RECEIVING_URL } from "@/lib/messaging/inbound-email";
import { POST } from "@/app/api/messaging/inbound/email/route";
import { OPS_ENTITY_MAP } from "../entities";
import { opsCreate, type OpsActor } from "../doctype";
import { runSlaSweep, sendTicketReply } from "../helpdesk";

const tag = randomUUID().replace(/-/g, "").slice(0, 10);
const WS = `helpdeskws${tag}`;
const WS_B = `helpdeskwsb${tag}`;
const A: OpsActor = { workspaceId: WS, userId: `user_${tag}` };
const SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const KEYS = ["MESSAGING_INBOUND_EMAIL_DOMAIN", "MESSAGING_INBOUND_EMAIL_SECRET", "RESEND_INBOUND_WEBHOOK_SECRET", "RESEND_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let bodyText = "My printer is jammed.";

function signed(raw: string): Request {
  const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
  const id = `msg_${randomBytes(6).toString("hex")}`;
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return new Request("http://x/api/messaging/inbound/email", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` },
    body: raw,
  });
}
const mail = (emailId: string, to: string, subject: string, from = "Grace Hopper <GRACE@navy.test>") =>
  JSON.stringify({ type: "email.received", data: { email_id: emailId, from, to: [to], cc: [], subject } });
const inWs = <T>(fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(WS, fn);

before(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.MESSAGING_INBOUND_EMAIL_DOMAIN = "reply.shapes.test";
  process.env.MESSAGING_INBOUND_EMAIL_SECRET = "helpdesk-db-test-secret";
  process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
  process.env.RESEND_API_KEY = "re_test_not_real";
  for (const id of [WS, WS_B]) {
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${"test:" + id}, now()) ON CONFLICT DO NOTHING`;
  }
  // MOCK: Resend receiving API (the webhook carries metadata only).
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.ok(url.startsWith(RESEND_RECEIVING_URL), `unexpected fetch ${url}`);
    return Response.json({ object: "email", text: bodyText });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const id of [WS, WS_B]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$disconnect();
});

describe("p10 helpdesk (real Postgres, app role)", () => {
  let ticketId = "";
  let number = 0;

  it("mail to the signed support address opens a ticket (idempotent per email id)", async () => {
    const support = supportAddressFor(WS)!;
    const res = await POST(signed(mail(`em_${tag}_1`, support, "Printer jam")));
    assert.deepEqual(await res.json(), { ok: true, action: "ticket_created" });
    const t = await inWs((tx) => tx.opsTicket.findFirst({ where: { workspaceId: WS }, include: { messages: true } }));
    assert.ok(t);
    ticketId = t.id;
    number = t.number;
    assert.equal(t.number, 1);
    assert.equal(t.channel, "email");
    assert.equal(t.requesterEmail, "grace@navy.test");
    assert.equal(t.requesterName, "Grace Hopper");
    assert.ok(t.firstResponseDueAt && t.resolutionDueAt, "SLA targets set");
    assert.equal(t.messages.length, 1);
    const again = await POST(signed(mail(`em_${tag}_1`, support, "Printer jam")));
    assert.deepEqual(await again.json(), { ok: true, action: "duplicate" });
    assert.equal(await inWs((tx) => tx.opsTicketMessage.count({ where: { ticketId } })), 1);
  });

  it("a reply sends through the provider stub, stamps the first response and goes pending", async () => {
    const sent: Array<{ to: string; subject: string; replyTo?: string }> = [];
    const r = await sendTicketReply(A, ticketId, { body: "Try turning it off and on." }, {
      meterSend: async () => ({ ok: true }),
      // STUB provider (labelled): records the call instead of emailing.
      sendEmail: async (i) => {
        sent.push(i);
        return { providerSid: "stub_sid_1" };
      },
    });
    assert.equal(r.sent, true);
    assert.equal(sent[0]!.to, "grace@navy.test");
    assert.equal(sent[0]!.subject, `Re: Printer jam [#${number}]`);
    assert.equal(sent[0]!.replyTo, supportAddressFor(WS));
    assert.equal(r.ticket.status, "pending");
    assert.ok(r.ticket.firstRespondedAt);
    assert.equal(r.message.deliveryStatus, "sent");
  });

  it("a failed send is recorded, not dropped", async () => {
    const r = await sendTicketReply(A, ticketId, { body: "Second try" }, {
      meterSend: async () => ({ ok: true }),
      sendEmail: async () => {
        throw new Error("provider down (stub)");
      },
    });
    assert.equal(r.sent, false);
    assert.equal(r.message.deliveryStatus, "failed");
    assert.match(r.message.error ?? "", /provider down/);
  });

  it("the customer's answer threads by [#n] and reopens the ticket", async () => {
    bodyText = "Still jammed.\n\nOn Tue someone wrote:\n> Try turning it off";
    const res = await POST(signed(mail(`em_${tag}_2`, supportAddressFor(WS)!, `Re: Printer jam [#${number}]`)));
    assert.deepEqual(await res.json(), { ok: true, action: "ticket_threaded" });
    const t = await inWs((tx) => tx.opsTicket.findFirst({ where: { id: ticketId }, include: { messages: { orderBy: { createdAt: "asc" } } } }));
    assert.equal(t?.status, "open");
    assert.equal(t?.messages.at(-1)?.body, "Still jammed.", "quoted original stripped");
  });

  it("a stranger can't thread onto someone else's ticket by guessing the number", async () => {
    const res = await POST(signed(mail(`em_${tag}_3`, supportAddressFor(WS)!, `Re: Printer jam [#${number}]`, "mallory@evil.test")));
    assert.deepEqual(await res.json(), { ok: true, action: "ticket_created" });
    assert.equal(await inWs((tx) => tx.opsTicket.count({ where: { workspaceId: WS } })), 2);
  });

  it("the SLA sweep records a breach once", async () => {
    const created = await withWorkspaceScope(WS, (tx) => opsCreate(tx, OPS_ENTITY_MAP["tickets"]!, A, { subject: "Urgent outage", priority: "urgent" }));
    const id = String((created as { row: Record<string, unknown> }).row.id);
    const later = new Date(Date.now() + 2 * 3600_000);
    const first = await inWs((tx) => runSlaSweep(tx, WS, later));
    assert.deepEqual(first.map((b) => [b.ticketId, b.kind]).filter(([t]) => t === id), [[id, "first_response"]]);
    const second = await inWs((tx) => runSlaSweep(tx, WS, later));
    assert.equal(second.filter((b) => b.ticketId === id).length, 0, "recorded once");
  });

  it("RLS: another workspace sees no tickets, messages or policies", async () => {
    const counts = await withWorkspaceScope(WS_B, async (tx) => [
      await tx.opsTicket.count({ where: { workspaceId: WS } }),
      await tx.opsTicketMessage.count({ where: { workspaceId: WS } }),
      await tx.opsSlaPolicy.count({ where: { workspaceId: WS } }),
    ]);
    assert.deepEqual(counts, [0, 0, 0]);
    const raw = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM ops_tickets`;
    assert.equal(Number(raw[0]!.n), 0, "no GUC → zero rows");
  });
});
