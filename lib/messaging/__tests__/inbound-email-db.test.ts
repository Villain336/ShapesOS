// ShapesOS — inbound email replies through the real route (Phase 4b).
//   - signed Resend email.received → body fetched from the receiving API
//     (mocked) → inbound ledger row on the right lead → shows in the inbox
//   - idempotent per Resend email id; bad signature 401; no secret 503;
//     forged reply address ignored; body fetch failure 502 (Resend retries)
// DB-backed (scripts/test/db-tests.txt); run as the least-privilege app role.
// Run: DATABASE_URL=… npx tsx --test lib/messaging/__tests__/inbound-email-db.test.ts

import "dotenv/config";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listThreads } from "@/lib/crm/inbox";
import { replyAddressFor, RESEND_RECEIVING_URL } from "../inbound-email";
import { POST } from "@/app/api/messaging/inbound/email/route";

const tag = randomUUID().replace(/-/g, "").slice(0, 10);
const WS = `inboundws${tag}`;
const SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const KEYS = ["MESSAGING_INBOUND_EMAIL_DOMAIN", "MESSAGING_INBOUND_EMAIL_SECRET", "RESEND_INBOUND_WEBHOOK_SECRET", "RESEND_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let leadId = "";
let fetched: string[] = [];
let bodyStatus = 200;

function signed(raw: string, secret = SECRET): Request {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const id = `msg_${randomBytes(6).toString("hex")}`;
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return new Request("http://x/api/messaging/inbound/email", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` },
    body: raw,
  });
}

function event(emailId: string, to: string, from = "Ada Lovelace <ADA@example.test>") {
  return JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: { email_id: emailId, created_at: new Date().toISOString(), from, to: [to], cc: [], bcc: [], subject: "Re: Your proposal", attachments: [] },
  });
}

before(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.MESSAGING_INBOUND_EMAIL_DOMAIN = "reply.shapes.test";
  process.env.MESSAGING_INBOUND_EMAIL_SECRET = "inbound-db-test-secret";
  process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
  process.env.RESEND_API_KEY = "re_test_not_real";
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
    VALUES (${WS}, ${WS}, ${"test:" + WS}, now()) ON CONFLICT DO NOTHING`;
  const pipe = await prisma.pipeline.create({ data: { workspaceId: WS, name: "Sales", stages: [{ id: "new", label: "New" }] } });
  const lead = await prisma.lead.create({ data: { workspaceId: WS, pipelineId: pipe.id, name: "Ada Lovelace", email: "ada@example.test" } });
  leadId = lead.id;
});

beforeEach(() => {
  fetched = [];
  bodyStatus = 200;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    assert.ok(url.startsWith(RESEND_RECEIVING_URL), `unexpected fetch ${url}`);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer re_test_not_real");
    if (bodyStatus !== 200) return new Response("{}", { status: bodyStatus });
    return Response.json({
      object: "email",
      id: url.split("/").pop(),
      subject: "Re: Your proposal",
      text: "Tuesday works for me.\n\nOn Mon, Sep 1, 2026 at 9:00 AM Shapes <x@y.z> wrote:\n> Can we meet?",
      html: "<p>Tuesday works for me.</p>",
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`.catch(() => {});
  await prisma.$disconnect();
});

describe("POST /api/messaging/inbound/email", () => {
  it("logs a signed reply on the sender's lead, quote-stripped, and threads it in the inbox", async () => {
    const to = replyAddressFor(WS)!;
    const res = await POST(signed(event(`em_${tag}_1`, to)));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, action: "logged" });
    assert.equal(fetched.length, 1);
    const row = await prisma.outboundMessage.findFirst({ where: { workspaceId: WS, providerSid: `em_${tag}_1` } });
    assert.equal(row?.leadId, leadId);
    assert.equal(row?.direction, "inbound");
    assert.equal(row?.channel, "email");
    assert.equal(row?.subject, "Re: Your proposal");
    assert.equal(row?.body, "Tuesday works for me.");
    const list = await withWorkspaceScope(WS, (tx) => listThreads(tx, { workspaceId: WS, userId: "someone" }));
    assert.equal(list.threads[0]?.leadId, leadId);
    assert.equal(list.threads[0]?.unreadCount, 1);
  });

  it("is idempotent per Resend email id", async () => {
    const to = replyAddressFor(WS)!;
    const res = await POST(signed(event(`em_${tag}_1`, to)));
    assert.deepEqual(await res.json(), { ok: true, action: "duplicate" });
    assert.equal(fetched.length, 0);
    assert.equal(await prisma.outboundMessage.count({ where: { workspaceId: WS, providerSid: `em_${tag}_1` } }), 1);
  });

  it("rejects a bad signature and ignores a forged reply address", async () => {
    const to = replyAddressFor(WS)!;
    const bad = await POST(signed(event(`em_${tag}_2`, to), `whsec_${randomBytes(24).toString("base64")}`));
    assert.equal(bad.status, 401);
    const forged = await POST(signed(event(`em_${tag}_3`, to.replace(/-[0-9a-f]{16}@/, "-0000000000000000@"))));
    assert.equal(forged.status, 200);
    assert.deepEqual(await forged.json(), { ok: true, action: "ignored" });
    assert.equal(fetched.length, 0);
    assert.equal(await prisma.outboundMessage.count({ where: { workspaceId: WS, providerSid: { in: [`em_${tag}_2`, `em_${tag}_3`] } } }), 0);
  });

  it("answers 502 when the body can't be fetched (Resend retries), storing nothing", async () => {
    bodyStatus = 500;
    const res = await POST(signed(event(`em_${tag}_4`, replyAddressFor(WS)!)));
    assert.equal(res.status, 502);
    assert.equal(await prisma.outboundMessage.count({ where: { workspaceId: WS, providerSid: `em_${tag}_4` } }), 0);
  });

  it("an unknown sender opens a helpdesk ticket instead of only being counted (Phase 10)", async () => {
    const res = await POST(signed(event(`em_${tag}_5`, replyAddressFor(WS)!, "stranger@elsewhere.test")));
    assert.deepEqual(await res.json(), { ok: true, action: "ticket_created" });
    assert.equal(await prisma.outboundMessage.count({ where: { workspaceId: WS, providerSid: `em_${tag}_5` } }), 0);
    const msg = await withWorkspaceScope(WS, (tx) => tx.opsTicketMessage.findFirst({ where: { providerSid: `em_${tag}_5` } }));
    assert.equal(msg?.fromEmail, "stranger@elsewhere.test");
    assert.equal(msg?.direction, "inbound");
  });

  it("fails closed without a webhook secret", async () => {
    const prev = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
    delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
    try {
      const res = await POST(signed(event(`em_${tag}_6`, replyAddressFor(WS)!)));
      assert.equal(res.status, 503);
    } finally {
      process.env.RESEND_INBOUND_WEBHOOK_SECRET = prev;
    }
  });
});
