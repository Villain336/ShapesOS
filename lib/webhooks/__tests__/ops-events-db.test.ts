// Phase 11 (conncore): Phase 9/10 business events reach outbound webhooks
// (Zapier / n8n / Make) through the Phase 4a queue — against Postgres as the
// app role. Writes go through the real ops service (opsCreate / opsPatch),
// the invoice payment path and the transactional outbox:
//   1. deal created → stage changed → won; ticket opened → solved; contact
//      created — one delivery row each, on a subscribed endpoint only;
//   2. a payment that settles an invoice emits invoice.paid ONCE (the Phase
//      4a route emit with the same dedup key is a no-op afterwards);
//   3. outbox atomicity: a write whose transaction rolls back leaves no event;
//   4. an endpoint filtered to deal.won receives nothing else.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/webhooks/__tests__/ops-events-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createEndpoint } from "../endpoints";
import { emitInvoicePaid } from "../emit";
import { opsCreate, opsEntityDef, opsPatch } from "@/lib/ops/doctype";
import { applyInvoicePayment } from "@/lib/ops/finance/invoicing";

const RUN = `p11w-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const OWNER = `${RUN}-owner`;
const resolve = async () => ["93.184.216.34"];
const actor = { workspaceId: WS, userId: OWNER };
let allEp = "";
let wonEp = "";
let pipelineId = "";

const deliveries = (endpointId: string) =>
  withWorkspaceScope(WS, (tx) => tx.webhookDelivery.findMany({ where: { workspaceId: WS, endpointId }, orderBy: { createdAt: "asc" } }));
const typesOf = async (endpointId: string) => (await deliveries(endpointId)).map((d) => d.eventType);

before(async () => {
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER, plan: "pro" } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: OWNER, role: "owner" } });
  allEp = (await createEndpoint(WS, OWNER, { url: "https://hooks.example.test/all", events: [] }, { resolve })).endpoint.id;
  wonEp = (await createEndpoint(WS, OWNER, { url: "https://hooks.example.test/won", events: ["deal.won"] }, { resolve })).endpoint.id;
  pipelineId = (
    await withWorkspaceScope(WS, (tx) =>
      tx.pipeline.create({ data: { workspaceId: WS, name: "Sales", stages: [{ id: "new", label: "New" }, { id: "proposal", label: "Proposal" }, { id: "won", label: "Won" }, { id: "lost", label: "Lost" }] } }),
    )
  ).id;
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

const done = (r: Awaited<ReturnType<typeof opsCreate>>) => {
  assert.equal(r.outcome, "done");
  return (r as { row: Record<string, unknown> }).row;
};

describe("Phase 9/10 events → outbound webhooks (transactional outbox)", () => {
  it("deal created → stage changed → won", async () => {
    const deal = done(await withWorkspaceScope(WS, (tx) => opsCreate(tx, opsEntityDef("deals"), actor, { title: "Acme rollout", pipelineId, stage: "new", valueCents: 50000 })));
    await withWorkspaceScope(WS, (tx) => opsPatch(tx, opsEntityDef("deals"), actor, { id: deal.id, stage: "proposal" }));
    await withWorkspaceScope(WS, (tx) => opsPatch(tx, opsEntityDef("deals"), actor, { id: deal.id, stage: "won" }));
    assert.deepEqual(await typesOf(allEp), ["deal.created", "deal.stage_changed", "deal.stage_changed", "deal.won"]);
    const won = (await deliveries(allEp)).at(-1)!;
    const env = won.payload as { type: string; data: { id: string; status: string; fromStage?: string } };
    assert.equal(env.type, "deal.won");
    assert.equal(env.data.id, deal.id);
    assert.equal(env.data.status, "won");
    assert.deepEqual(await typesOf(wonEp), ["deal.won"], "a filtered endpoint only gets what it subscribed to");
  });

  it("ticket opened → solved; contact created", async () => {
    const ticket = done(await withWorkspaceScope(WS, (tx) => opsCreate(tx, opsEntityDef("tickets"), actor, { subject: "Printer on fire", channel: "email", requesterEmail: "ada@example.com" })));
    await withWorkspaceScope(WS, (tx) => opsPatch(tx, opsEntityDef("tickets"), actor, { id: ticket.id, status: "solved" }));
    await withWorkspaceScope(WS, (tx) => opsCreate(tx, opsEntityDef("contacts"), actor, { name: "Ada Lovelace", email: "ada@example.com" }));
    assert.deepEqual((await typesOf(allEp)).slice(-3), ["ticket.created", "ticket.solved", "contact.created"]);
  });

  it("a payment that settles an invoice emits invoice.paid once", async () => {
    const inv = await withWorkspaceScope(WS, (tx) =>
      tx.opsInvoice.create({ data: { workspaceId: WS, lineItems: [{ description: "Work", qty: 1, priceCents: 1000 }], taxCents: 0, totalCents: 1000, status: "sent", sentAt: new Date() } }),
    );
    await withWorkspaceScope(WS, (tx) => applyInvoicePayment(tx, actor, { invoiceId: inv.id, amountCents: 1000 }));
    // The Phase 4a route emit for the same invoice is deduplicated.
    await emitInvoicePaid(WS, { ...inv, status: "paid" } as unknown as Record<string, unknown>);
    const paid = (await deliveries(allEp)).filter((d) => d.eventType === "invoice.paid");
    assert.equal(paid.length, 1);
    assert.equal((paid[0].payload as { data: { id: string } }).data.id, inv.id);
  });

  it("outbox atomicity: a rolled-back write leaves no event", async () => {
    const before = (await deliveries(allEp)).length;
    await assert.rejects(
      withWorkspaceScope(WS, async (tx) => {
        await opsCreate(tx, opsEntityDef("contacts"), actor, { name: "Ghost", email: "ghost@example.com" });
        throw new Error("boom — roll back");
      }),
      /boom/,
    );
    assert.equal((await deliveries(allEp)).length, before);
    const ghost = await withWorkspaceScope(WS, (tx) => tx.opsContact.findFirst({ where: { workspaceId: WS, email: "ghost@example.com" } }));
    assert.equal(ghost, null);
  });
});
