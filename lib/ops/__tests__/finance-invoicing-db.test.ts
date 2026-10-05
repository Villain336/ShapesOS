// ShapesOS — Phase 10 (finance): invoicing + quotes on real Postgres, as the
// least-privilege app role.
//   - send (approved) assigns INV-0001… gap-free, also under concurrency, and
//     a rolled-back send returns its number; the send posts Dr AR / Cr Sales+Tax
//   - line tax from OpsTaxRate; partial payments (gated) move the balance and
//     the status; overpayment refused; mark-paid settles the rest
//   - credit notes (gated) reduce the balance and post the mirror entry;
//     void reverses the AR posting; re-posting a source is a no-op
//   - recurring schedules draft once per period; quotes number on send and
//     convert to a linked draft invoice / order (idempotent)
//   - the tenant Stripe webhook verifies the signature and applies a payment once
//   - invoice PDF renders through the lib/pdf engine
// Run (DB suite): DATABASE_URL=… npx tsx --test lib/ops/__tests__/finance-invoicing-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { opsCreate, opsPatch, OpsError, type OpsActor } from "../doctype";
import { opsBindingFor, phase14GatePort, type OpsGatePort } from "../gate";
import { findEntryBySource, listJournal } from "../accounting";
import { postInvoiceIssued } from "../finance/posting";
import { invoiceAccount, issueCreditNote, renderInvoicePdf } from "../finance/invoicing";
import { draftDueRecurringInvoices } from "../finance/recurring";
import { convertQuote, expireQuotes } from "../finance/quotes";
import { handleStripeWebhook, saveFinanceSettings, type StripeFactory } from "../finance/stripe";

const WS = "p10fin-inv";
const ACTOR: OpsActor = { workspaceId: WS, userId: "user_p10fin" };
const INVOICES = OPS_ENTITY_MAP["invoices"]!;
const PAYMENTS = OPS_ENTITY_MAP["payments"]!;
const QUOTES = OPS_ENTITY_MAP["quotes"]!;
const RECURRING = OPS_ENTITY_MAP["recurring-invoices"]!;
const TAX = OPS_ENTITY_MAP["tax-rates"]!;

const proposeOnly: OpsGatePort = { ...phase14GatePort, propose: async () => ({ id: "appr_pending", status: "pending", riskTier: "medium" }) };

async function approved(slug: string, binding: Parameters<typeof opsBindingFor>[0]): Promise<string> {
  const row = await withWorkspaceScope(WS, (tx) =>
    tx.composioActionApproval.create({
      data: {
        workspaceId: WS,
        appKey: "ops",
        toolName: slug,
        riskTier: "medium",
        proposedArgs: opsBindingFor(binding) as object,
        plainSummary: "test",
        status: "approved",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    }),
  );
  return row.id;
}

async function draftInvoice(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await withWorkspaceScope(WS, (tx) => opsCreate(tx, INVOICES, ACTOR, body));
  assert.equal(r.outcome, "done");
  return (r as { row: Record<string, unknown> }).row;
}

async function send(id: string): Promise<Record<string, unknown>> {
  const approvalId = await approved("OPS_INVOICE_SEND", { entity: "invoices", entityId: id, slug: "OPS_INVOICE_SEND", mutation: { id, status: "sent" } });
  const r = await withWorkspaceScope(WS, (tx) => opsPatch(tx, INVOICES, ACTOR, { id, status: "sent", approvalId }, { gatePort: phase14GatePort }));
  assert.equal(r.outcome, "done");
  return (r as { row: Record<string, unknown> }).row;
}

async function pay(invoiceId: string, amountCents: number, extra: Record<string, unknown> = {}) {
  const body = { invoiceId, kind: "charge", status: "succeeded", amountCents, provider: "manual", ...extra };
  const parsed = PAYMENTS.createSchema.parse(body) as Record<string, unknown>;
  const approvalId = await approved("OPS_PAYMENT_RECORD_CHARGE", { entity: "payments", slug: "OPS_PAYMENT_RECORD_CHARGE", mutation: { ...parsed } });
  return withWorkspaceScope(WS, (tx) => opsCreate(tx, PAYMENTS, ACTOR, { ...body, approvalId }, { gatePort: phase14GatePort }));
}

const inv = (id: string) => withWorkspaceScope(WS, (tx) => tx.opsInvoice.findFirstOrThrow({ where: { id } }));
const LINES = [{ description: "Consulting", qty: 10, priceCents: 10_000 }];

before(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${WS}, ${"Acme Ltd"}, ${"test:" + WS}, now())`;
});

after(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$disconnect();
});

describe("invoice numbering + posting on send", () => {
  it("send assigns INV-0001 and posts Dr AR / Cr Sales + Tax payable with line tax", async () => {
    const rate = await withWorkspaceScope(WS, (tx) => opsCreate(tx, TAX, ACTOR, { name: "State tax", rateBps: 825 }));
    const rateId = String((rate as { row: Record<string, unknown> }).row.id);
    const draft = await draftInvoice({ lineItems: [{ description: "Website", qty: 1, priceCents: 100_000, taxRateId: rateId }], taxCents: 99 });
    assert.equal(draft.taxCents, 8_250, "line tax computed server-side; client tax ignored");
    assert.equal(draft.totalCents, 108_250);
    assert.equal(draft.number, null, "drafts have no number");
    const sent = await send(String(draft.id));
    assert.equal(sent.number, "INV-0001");
    const entry = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `invoice:${String(draft.id)}:issue`));
    assert.ok(entry, "AR posting exists");
    assert.equal(entry!.totalCents, 108_250);
    const byCode = Object.fromEntries(entry!.lines.map((l) => [l.accountCode, l.debitCents || -l.creditCents]));
    assert.deepEqual(byCode, { "1100": 108_250, "4000": -100_000, "2100": -8_250 });
  });

  it("five concurrent sends get five distinct, consecutive numbers (gap-free)", async () => {
    const drafts = await Promise.all(Array.from({ length: 5 }, () => draftInvoice({ lineItems: LINES })));
    const sent = await Promise.all(drafts.map((d) => send(String(d.id))));
    const nums = sent.map((s) => String(s.number)).sort();
    assert.deepEqual(nums, ["INV-0002", "INV-0003", "INV-0004", "INV-0005", "INV-0006"]);
  });

  it("a rolled-back send returns its number (no gap)", async () => {
    const d = await draftInvoice({ lineItems: LINES });
    const approvalId = await approved("OPS_INVOICE_SEND", { entity: "invoices", entityId: String(d.id), slug: "OPS_INVOICE_SEND", mutation: { id: String(d.id), status: "sent" } });
    await assert.rejects(
      withWorkspaceScope(WS, async (tx) => {
        await opsPatch(tx, INVOICES, ACTOR, { id: d.id, status: "sent", approvalId }, { gatePort: phase14GatePort });
        throw new Error("simulated failure after send");
      }),
      /simulated failure/,
    );
    const next = await send(String((await draftInvoice({ lineItems: LINES })).id));
    assert.equal(next.number, "INV-0007");
  });

  it("re-posting an already-posted invoice is a no-op", async () => {
    const row = await inv((await send(String((await draftInvoice({ lineItems: LINES })).id))).id as string);
    const again = await withWorkspaceScope(WS, (tx) => postInvoiceIssued(tx, ACTOR, row));
    assert.equal(again?.created, false);
    const n = await withWorkspaceScope(WS, (tx) => tx.opsJournalEntry.count({ where: { workspaceId: WS, sourceKey: `invoice:${row.id}:issue` } }));
    assert.equal(n, 1);
  });
});

describe("partial payments", () => {
  it("a payment without approval only proposes — nothing is written", async () => {
    const d = await send(String((await draftInvoice({ lineItems: LINES })).id));
    const r = await withWorkspaceScope(WS, (tx) =>
      opsCreate(tx, PAYMENTS, ACTOR, { invoiceId: d.id, kind: "charge", status: "succeeded", amountCents: 1_000 }, { gatePort: proposeOnly }),
    );
    assert.equal(r.outcome, "approval_required");
    assert.equal((await inv(String(d.id))).paidCents, 0);
  });

  it("partial → still sent; overpay refused; rest → paid; ledger Dr Cash / Cr AR", async () => {
    const d = await send(String((await draftInvoice({ lineItems: LINES })).id));
    const id = String(d.id);
    await pay(id, 40_000);
    let row = await inv(id);
    assert.equal(row.paidCents, 40_000);
    assert.equal(row.status, "sent");
    await assert.rejects(pay(id, 60_001), (e: unknown) => e instanceof OpsError && /exceeds the balance/.test(e.message));
    await pay(id, 60_000);
    row = await inv(id);
    assert.equal(row.status, "paid");
    const acct = await withWorkspaceScope(WS, (tx) => invoiceAccount(tx, WS, id));
    assert.equal(acct.payments.length, 2);
    assert.equal(acct.balanceDueCents, 0);
    const entries = await withWorkspaceScope(WS, (tx) => listJournal(tx, WS, { sourceType: "payment" }));
    assert.ok(entries.filter((e) => acct.payments.some((p) => p.id === e.sourceId)).length === 2);
  });

  it("mark paid (gated) settles the remaining balance with one manual payment", async () => {
    const d = await send(String((await draftInvoice({ lineItems: LINES })).id));
    const id = String(d.id);
    await pay(id, 25_000);
    const approvalId = await approved("OPS_INVOICE_MARK_PAID", { entity: "invoices", entityId: id, slug: "OPS_INVOICE_MARK_PAID", mutation: { id, status: "paid" } });
    const r = await withWorkspaceScope(WS, (tx) => opsPatch(tx, INVOICES, ACTOR, { id, status: "paid", approvalId }, { gatePort: phase14GatePort }));
    assert.equal(r.outcome, "done");
    assert.equal((r as { row: Record<string, unknown> }).row.settledCents, 75_000);
    const row = await inv(id);
    assert.equal(row.paidCents, 100_000);
  });
});

describe("credit notes and voids", () => {
  it("a credit note reduces the balance, numbers CN-0001 and posts the mirror", async () => {
    const d = await send(String((await draftInvoice({ lineItems: LINES, taxCents: 10_000 })).id));
    const id = String(d.id);
    const r = await withWorkspaceScope(WS, (tx) => issueCreditNote(tx, ACTOR, id, { reason: "Late delivery", amountCents: 22_000 }));
    assert.equal(r.creditNote.number, "CN-0001");
    assert.equal(r.creditNote.kind, "credit_note");
    assert.equal(r.creditNote.taxCents, 2_000, "pro-rata tax");
    const row = await inv(id);
    assert.equal(row.creditedCents, 22_000);
    assert.equal(row.status, "sent");
    const entry = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `credit_note:${r.creditNote.id}:issue`));
    const byCode = Object.fromEntries(entry!.lines.map((l) => [l.accountCode, l.debitCents || -l.creditCents]));
    assert.deepEqual(byCode, { "4000": 20_000, "2100": 2_000, "1100": -22_000 });
    await assert.rejects(
      withWorkspaceScope(WS, (tx) => issueCreditNote(tx, ACTOR, id, { reason: "too much", amountCents: 100_000 })),
      /exceeds the balance/,
    );
    await assert.rejects(
      withWorkspaceScope(WS, (tx) => opsPatch(tx, INVOICES, ACTOR, { id: r.creditNote.id, customerEmail: "x@example.com" })),
      /Credit notes are issued, not edited/,
    );
  });

  it("voiding a sent invoice without payments reverses its AR posting", async () => {
    const d = await send(String((await draftInvoice({ lineItems: LINES })).id));
    const id = String(d.id);
    const approvalId = await approved("OPS_RECORD_DELETE", { entity: "invoices", entityId: id, slug: "OPS_RECORD_DELETE", mutation: { id, status: "cancelled" } });
    const r = await withWorkspaceScope(WS, (tx) => opsPatch(tx, INVOICES, ACTOR, { id, status: "cancelled", approvalId }, { gatePort: phase14GatePort }));
    const revId = (r as { row: Record<string, unknown> }).row.reversalEntryId as string;
    assert.ok(revId);
    const issued = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `invoice:${id}:issue`));
    assert.equal(issued!.reversedById, revId);
  });
});

describe("recurring invoices", () => {
  it("drafts each due period once, even when the sweep runs twice", async () => {
    const r = await withWorkspaceScope(WS, (tx) =>
      opsCreate(tx, RECURRING, ACTOR, { lineItems: LINES, cadence: "monthly", startAt: "2026-08-01T00:00:00Z" }),
    );
    const scheduleId = String((r as { row: Record<string, unknown> }).row.id);
    const now = new Date("2026-10-04T00:00:00Z");
    const first = await withWorkspaceScope(WS, (tx) => draftDueRecurringInvoices(tx, { ...ACTOR, userId: "cron:finance" }, now));
    const mine = first.find((x) => x.scheduleId === scheduleId)!;
    assert.equal(mine.drafted.length, 3, "Aug, Sep, Oct");
    assert.equal(mine.nextRunAt.toISOString().slice(0, 10), "2026-11-01");
    const second = await withWorkspaceScope(WS, (tx) => draftDueRecurringInvoices(tx, { ...ACTOR, userId: "cron:finance" }, now));
    assert.equal(second.find((x) => x.scheduleId === scheduleId), undefined, "nothing due on the rerun");
    const drafts = await withWorkspaceScope(WS, (tx) => tx.opsInvoice.findMany({ where: { workspaceId: WS, recurringId: scheduleId } }));
    assert.equal(drafts.length, 3);
    assert.ok(drafts.every((x) => x.status === "draft"), "drafts only — sending still asks");
  });
});

describe("quotes", () => {
  it("send (gated) numbers QUO-0001; convert to invoice and order, linked and idempotent; expiry", async () => {
    const q = await withWorkspaceScope(WS, (tx) => opsCreate(tx, QUOTES, ACTOR, { lineItems: [{ description: "Build", qty: 2, priceCents: 50_000, sku: "B" }], taxCents: 5_000 }));
    const qid = String((q as { row: Record<string, unknown> }).row.id);
    const proposed = await withWorkspaceScope(WS, (tx) => opsPatch(tx, QUOTES, ACTOR, { id: qid, status: "sent" }, { gatePort: proposeOnly }));
    assert.equal(proposed.outcome, "approval_required");
    const approvalId = await approved("OPS_QUOTE_SEND", { entity: "quotes", entityId: qid, slug: "OPS_QUOTE_SEND", mutation: { id: qid, status: "sent" } });
    const sent = await withWorkspaceScope(WS, (tx) => opsPatch(tx, QUOTES, ACTOR, { id: qid, status: "sent", approvalId }, { gatePort: phase14GatePort }));
    assert.equal((sent as { row: Record<string, unknown> }).row.number, "QUO-0001");

    const toInv = await withWorkspaceScope(WS, (tx) => convertQuote(tx, ACTOR, qid, "invoice"));
    assert.equal(toInv.created, true);
    assert.equal(toInv.quote.status, "accepted");
    const again = await withWorkspaceScope(WS, (tx) => convertQuote(tx, ACTOR, qid, "invoice"));
    assert.equal(again.created, false);
    assert.equal(again.id, toInv.id);
    const invoice = await inv(toInv.id);
    assert.equal(invoice.quoteId, qid);
    assert.equal(invoice.status, "draft");
    assert.equal(invoice.totalCents, 105_000);
    const toOrder = await withWorkspaceScope(WS, (tx) => convertQuote(tx, ACTOR, qid, "order"));
    const order = await withWorkspaceScope(WS, (tx) => tx.opsOrder.findFirstOrThrow({ where: { id: toOrder.id } }));
    assert.equal(order.quoteId, qid);
    assert.deepEqual(order.lineItems, [{ name: "Build", sku: "B", qty: 2, priceCents: 50_000 }]);

    const q2 = await withWorkspaceScope(WS, (tx) => opsCreate(tx, QUOTES, ACTOR, { lineItems: LINES, validUntil: "2026-01-01T00:00:00Z" }));
    const q2id = String((q2 as { row: Record<string, unknown> }).row.id);
    const a2 = await approved("OPS_QUOTE_SEND", { entity: "quotes", entityId: q2id, slug: "OPS_QUOTE_SEND", mutation: { id: q2id, status: "sent" } });
    await withWorkspaceScope(WS, (tx) => opsPatch(tx, QUOTES, ACTOR, { id: q2id, status: "sent", approvalId: a2 }, { gatePort: phase14GatePort }));
    const expired = await withWorkspaceScope(WS, (tx) => expireQuotes(tx, ACTOR, new Date("2026-10-04T00:00:00Z")));
    assert.deepEqual(expired, [q2id]);
  });
});

describe("tenant Stripe webhook", () => {
  const SECRET_KEY = "sk_test_51Habcdefghijklmnop";
  const WHSEC = "whsec_testsecret12345678";
  // The real Stripe SDK verifies signatures offline; no network is used.
  const sdk = new Stripe(SECRET_KEY);
  const factory: StripeFactory = () => sdk as never;

  it("verifies the signature, applies the payment once, and refuses bad signatures", async () => {
    await withWorkspaceScope(WS, (tx) => saveFinanceSettings(tx, ACTOR, { stripeSecretKey: SECRET_KEY, stripeWebhookSecret: WHSEC }));
    const d = await send(String((await draftInvoice({ lineItems: LINES })).id));
    const id = String(d.id);
    const payload = JSON.stringify({
      id: "evt_1",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", object: "checkout.session", payment_status: "paid", amount_total: 100_000, payment_intent: "pi_1", metadata: { workspace_id: WS, invoice_id: id } } },
    });
    const header = sdk.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    const bad = await handleStripeWebhook(WS, payload, `${header}x`, { stripe: factory });
    assert.equal(bad.status, 400);
    const ok = await handleStripeWebhook(WS, payload, header, { stripe: factory });
    assert.equal(ok.status, 200);
    const dup = await handleStripeWebhook(WS, payload, header, { stripe: factory });
    assert.equal(dup.body.duplicate, true);
    const row = await inv(id);
    assert.equal(row.status, "paid");
    const payments = await withWorkspaceScope(WS, (tx) => tx.opsPayment.findMany({ where: { invoiceId: id } }));
    assert.equal(payments.length, 1);
    assert.equal(payments[0]!.provider, "stripe");
    const noSecret = await handleStripeWebhook("p10fin-nowhere", payload, header, { stripe: factory });
    assert.equal(noSecret.status, 503);
  });
});

describe("invoice PDF", () => {
  it("renders through the lib/pdf engine", async () => {
    const d = await send(String((await draftInvoice({ lineItems: LINES })).id));
    const { pdf, filename } = await renderInvoicePdf(WS, String(d.id));
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.match(filename, /^invoice-INV-\d{4}\.pdf$/);
  });
});
