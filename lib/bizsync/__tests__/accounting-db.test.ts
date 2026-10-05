// Phase 11 (bizsync): accounting export + contact import against Postgres
// (app role) with a FAKE QuickBooks Online (in-memory; it honours ?requestid=
// the way Intuit documents it — a repeated id returns the original response).
// A labelled test fake: the live API is UNVERIFIED-LIVE.
//   1. Mapping: suggestions stored, confirmed by a person; a class mismatch
//      is refused; exports skip anything whose accounts aren't confirmed.
//   2. Export: posted invoice, payment, bill, bill payment, manual journal
//      and its reversal go out once each (customer/vendor/item created once);
//      a reversal of a document posting is skipped for a person.
//   3. Idempotency: a second export is a no-op (zero POSTs); an interrupted
//      call stays "pending" and the retry reuses the requestid (one remote
//      document); two concurrent exports post once; a definitive 400 bumps
//      the attempt and the fixed retry uses a new requestid.
//   4. The ledger is never mutated: journal entries/lines are identical
//      before and after exports and imports.
//   5. Contacts: customers → contacts (dedupe by email), vendors → vendors
//      (dedupe by name), re-import no-op, workspace-only.
//   6. ops_accounting_links / ops_accounting_exports are FORCE RLS.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/bizsync/__tests__/accounting-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { countWithoutScope, withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { publicResolve } from "@/lib/connectors/m21/live/__tests__/fixtures";
import { ensureChartOfAccounts, postEntry, reverseEntry } from "@/lib/ops/accounting";
import { postBillPayment, postInvoiceIssued, postInvoicePayment, postVendorBill } from "@/lib/ops/finance/posting";
import { confirmMapping, mappingRows, MappingError, saveSuggestions } from "../accounting/mapping";
import { exportToAccounting, exportStatus } from "../accounting/export";
import { importParties } from "../accounting/contacts";
import { quickbooksProvider } from "../quickbooks/provider";
import type { OpsActor } from "@/lib/ops/doctype";

const RUN = `p11q-${Date.now().toString(36)}`;
const WS = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
const actor: OpsActor = { workspaceId: WS, userId: USER };
const REALM = "9130350000000001";

// ---------------------------------------------------------------------------
// FAKE QuickBooks Online (tests only)
// ---------------------------------------------------------------------------
type Doc = Record<string, unknown> & { Id: string };
const qbo = {
  Account: [
    { Id: "35", Name: "Checking", AccountType: "Bank", AccountSubType: "Checking", Classification: "Asset", Active: true },
    { Id: "84", Name: "Accounts Receivable (A/R)", AccountType: "Accounts Receivable", Classification: "Asset", Active: true },
    { Id: "33", Name: "Accounts Payable (A/P)", AccountType: "Accounts Payable", Classification: "Liability", Active: true },
    { Id: "79", Name: "Sales of Product Income", AccountType: "Income", Classification: "Revenue", Active: true },
    { Id: "7", Name: "Office Expenses", AccountType: "Expense", Classification: "Expense", Active: true },
    { Id: "90", Name: "Opening Balance Equity", AccountType: "Equity", Classification: "Equity", Active: true },
  ] as Doc[],
  Customer: [
    { Id: "58", DisplayName: "Ada Lovelace", PrimaryEmailAddr: { Address: "Ada@Example.com" }, MetaData: { LastUpdatedTime: "2026-09-01T10:00:00-07:00" } },
    { Id: "59", DisplayName: "Grace Hopper", PrimaryEmailAddr: { Address: "grace@example.com" }, MetaData: { LastUpdatedTime: "2026-09-01T10:00:00-07:00" } },
  ] as Doc[],
  Vendor: [{ Id: "12", DisplayName: "Paper Co", PrimaryEmailAddr: { Address: "ap@paper.test" }, MetaData: { LastUpdatedTime: "2026-09-01T10:00:00-07:00" } }] as Doc[],
  Item: [] as Doc[],
  Invoice: [] as Doc[],
  CreditMemo: [] as Doc[],
  Bill: [] as Doc[],
  Payment: [] as Doc[],
  BillPayment: [] as Doc[],
  JournalEntry: [] as Doc[],
};
const ENTITY: Record<string, keyof typeof qbo> = { customer: "Customer", vendor: "Vendor", item: "Item", invoice: "Invoice", creditmemo: "CreditMemo", bill: "Bill", payment: "Payment", billpayment: "BillPayment", journalentry: "JournalEntry" };
const byRequestId = new Map<string, string>(); // requestid → response body
const posts: Array<{ entity: string; requestid: string; body: Record<string, unknown> }> = [];
let nextId = 1000;
/** Test switches. */
const faults = { rejectNextBill: false, lostResponses: 0, dropConnection: false };

const fakeQbo = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  assert.equal(url.host, "quickbooks.api.intuit.com");
  assert.equal(url.searchParams.get("minorversion"), "75");
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer qbo-token");
  const m = url.pathname.match(/^\/v3\/company\/(\d+)\/(\w+)$/);
  assert.ok(m && m[1] === REALM, url.pathname);
  if (m![2] === "query") {
    const q = url.searchParams.get("query") ?? "";
    const entity = /from (\w+)/i.exec(q)![1] as keyof typeof qbo;
    let rows = qbo[entity];
    const eq = /where (\w+) = '((?:[^'\\]|\\.)*)'/i.exec(q);
    if (eq) rows = rows.filter((r) => String(r[eq[1]!]) === eq[2]!.replace(/\\(.)/g, "$1"));
    const start = Number(/startposition (\d+)/i.exec(q)?.[1] ?? 1);
    const max = Number(/maxresults (\d+)/i.exec(q)?.[1] ?? 1000);
    return json(200, { QueryResponse: { [entity]: rows.slice(start - 1, start - 1 + max) } });
  }
  if (faults.dropConnection) throw new TypeError("fetch failed (fake: connection dropped)");
  const entityPath = m![2]!;
  const entity = ENTITY[entityPath]!;
  const requestid = url.searchParams.get("requestid") ?? "";
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  const prior = byRequestId.get(requestid);
  if (prior) return new Response(prior, { status: 200, headers: { "content-type": "application/json" } });
  if (entity === "Bill" && faults.rejectNextBill) {
    faults.rejectNextBill = false;
    return json(400, { Fault: { Error: [{ Message: "Business Validation Error", Detail: "Vendor is inactive", code: "6000" }], type: "ValidationFault" } });
  }
  posts.push({ entity: entityPath, requestid, body });
  const doc: Doc = { ...body, Id: String(nextId++), ...(entity === "Invoice" && !body.DocNumber ? { DocNumber: String(nextId) } : {}) };
  qbo[entity].push(doc);
  const response = JSON.stringify({ [entity]: doc, time: "2026-10-04T00:00:00Z" });
  byRequestId.set(requestid, response);
  if (faults.lostResponses > 0) {
    faults.lostResponses -= 1;
    return json(503, { Fault: { Error: [{ Message: "Service unavailable" }], type: "SystemFault" } });
  }
  return new Response(response, { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const deps = { fetchImpl: fakeQbo, resolve: publicResolve, sleep: async () => undefined };
const provider = (extra: Record<string, unknown> = {}) => quickbooksProvider(WS, { realmId: REALM, token: { token: "qbo-token" } }, { ...deps, ...extra });

const ids: Record<string, string> = {};

before(async () => {
  for (const id of [WS, WS_B]) await prisma.workspace.create({ data: { id, name: `P11 ${id}`, ownerUserId: USER } });
  await withWorkspaceScope(WS, async (tx) => {
    await ensureChartOfAccounts(tx, WS);
    const inv = await tx.opsInvoice.create({ data: { workspaceId: WS, lineItems: [{ description: "Design", qty: 2, priceCents: 5000 }], taxCents: 0, totalCents: 10000, status: "sent", number: "INV-0001", sentAt: new Date("2026-09-10T12:00:00Z"), customerEmail: "ada@example.com" } });
    ids.invoice = inv.id;
    ids.invoiceEntry = (await postInvoiceIssued(tx, actor, inv))!.entry.id;
    const pay = await tx.opsPayment.create({ data: { workspaceId: WS, invoiceId: inv.id, amountCents: 10000, kind: "charge", status: "succeeded", provider: "manual", createdAt: new Date("2026-09-12T12:00:00Z") } });
    ids.payment = pay.id;
    await postInvoicePayment(tx, actor, { id: pay.id, amountCents: 10000, invoiceId: inv.id, createdAt: pay.createdAt });
    const vendor = await tx.opsVendor.create({ data: { workspaceId: WS, name: "Paper Co" } });
    ids.vendor = vendor.id;
    const bill = await tx.opsVendorBill.create({ data: { workspaceId: WS, vendorId: vendor.id, number: "BILL-0001", vendorRef: "PC-77", lineItems: [{ description: "Paper", qty: 1, priceCents: 1999 }], subtotalCents: 1999, totalCents: 1999, status: "open", billDate: new Date("2026-09-11T12:00:00Z") } });
    ids.bill = bill.id;
    await postVendorBill(tx, actor, bill);
    const out = await tx.opsPayment.create({ data: { workspaceId: WS, billId: bill.id, amountCents: 1999, kind: "payout", status: "succeeded", provider: "manual", createdAt: new Date("2026-09-13T12:00:00Z") } });
    await postBillPayment(tx, actor, { id: out.id, amountCents: 1999, billId: bill.id, createdAt: out.createdAt });
    const manual = await postEntry(tx, actor, { entryDate: new Date("2026-09-14T12:00:00Z"), memo: "Owner contribution", sourceType: "manual", lines: [{ account: { key: "cash" }, debitCents: 50000, creditCents: 0 }, { account: { key: "owner_equity" }, debitCents: 0, creditCents: 50000 }] });
    ids.manual = manual.entry.id;
    ids.manualReversal = (await reverseEntry(tx, actor, manual.entry.id, { entryDate: new Date("2026-09-15T12:00:00Z") })).entry.id;
    ids.invoiceReversal = (await reverseEntry(tx, actor, ids.invoiceEntry, { entryDate: new Date("2026-09-16T12:00:00Z") })).entry.id;
  });
});

after(async () => {
  for (const id of [WS, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

const ledger = () =>
  withWorkspaceScope(WS, async (tx) => ({
    entries: await tx.opsJournalEntry.findMany({ where: { workspaceId: WS }, orderBy: { id: "asc" } }),
    lines: await tx.opsJournalLine.findMany({ where: { workspaceId: WS }, orderBy: { id: "asc" } }),
  }));
const exports = () => withWorkspaceScope(WS, (tx) => tx.opsAccountingExport.findMany({ where: { workspaceId: WS, provider: "quickbooks" } }));

let ledgerBefore: Awaited<ReturnType<typeof ledger>>;

describe("account mapping", () => {
  it("suggestions are stored, unconfirmed exports skip, and a person confirms", async () => {
    ledgerBefore = await ledger();
    const remote = await provider().listAccounts();
    assert.equal(remote.length, 6);
    const n = await saveSuggestions(WS, "quickbooks", remote);
    assert.equal(n, 4, "cash, A/R, A/P by role + sales by type");
    const rows = await mappingRows(WS, "quickbooks");
    const cash = rows.find((r) => r.account.systemKey === "cash")!;
    assert.equal(cash.link?.remoteAccountId, "35");
    assert.equal(cash.link?.status, "suggested");

    const r0 = await exportToAccounting(WS, provider(), { userId: USER });
    assert.equal(r0.exported.length, 0);
    assert.ok(r0.skipped.some((s) => /not mapped to QuickBooks/.test(s.reason)));
    assert.equal(posts.length, 0, "nothing reaches QuickBooks before the mapping is confirmed");
    assert.equal((await exports()).length, 0);

    const sales = rows.find((r) => r.account.systemKey === "sales")!;
    await assert.rejects(confirmMapping(WS, "quickbooks", [{ accountId: sales.account.id, remoteAccountId: "35" }], remote, USER), MappingError);
    const general = rows.find((r) => r.account.systemKey === "expense_general")!;
    const equity = rows.find((r) => r.account.systemKey === "owner_equity")!;
    const entries = rows.filter((r) => r.link).map((r) => ({ accountId: r.account.id, remoteAccountId: r.link!.remoteAccountId }));
    entries.push({ accountId: general.account.id, remoteAccountId: "7" }, { accountId: equity.account.id, remoteAccountId: "90" });
    const res = await confirmMapping(WS, "quickbooks", entries, remote, USER);
    assert.equal(res.confirmed, 6);
    assert.equal((await mappingRows(WS, "quickbooks")).find((r) => r.account.id === sales.account.id)?.link?.status, "confirmed");
  });
});

describe("export", () => {
  it("posts each posted source once, in date order; a document reversal is left to a person", async () => {
    const r = await exportToAccounting(WS, provider(), { userId: USER });
    const keys = r.exported.map((e) => e.sourceKey);
    assert.deepEqual(keys, [`invoice:${ids.invoice}`, `bill:${ids.bill}`, `payment:${ids.payment}`, keys[3], `journal:${ids.manual}`, `journal:${ids.manualReversal}`]);
    assert.match(keys[3]!, /^bill_payment:/);
    assert.ok(r.skipped.some((s) => s.sourceKey === `journal:${ids.invoiceReversal}` && /void or credit that invoice in QuickBooks by hand/.test(s.reason)));
    assert.equal(r.failed, 0);
    assert.deepEqual(posts.map((p) => p.entity).sort(), ["bill", "billpayment", "customer", "invoice", "item", "journalentry", "journalentry", "payment"]);
    const inv = qbo.Invoice[0]!;
    assert.equal((inv.CustomerRef as { value: string }).value, qbo.Customer.at(-1)!.Id);
    assert.equal(inv.DocNumber, "INV-0001");
    const payment = qbo.Payment[0]!;
    assert.deepEqual((payment.Line as Array<{ LinkedTxn: unknown }>)[0]!.LinkedTxn, [{ TxnId: inv.Id, TxnType: "Invoice" }]);
    assert.equal((qbo.Bill[0]!.VendorRef as { value: string }).value, "12", "existing QuickBooks vendor found by name, not duplicated");
    assert.equal(qbo.Vendor.length, 1);
    const status = await exportStatus(WS, "quickbooks");
    assert.equal(status.exported, 6);
  });

  it("a second export is a no-op (no POSTs)", async () => {
    const before = posts.length;
    const r = await exportToAccounting(WS, provider(), { userId: USER });
    assert.equal(r.exported.length, 0);
    assert.equal(r.alreadyExported, 6);
    assert.equal(posts.length, before);
  });

  it("an interrupted call stays pending and the retry reuses its requestid — one remote document", async () => {
    await withWorkspaceScope(WS, (tx) => postEntry(tx, actor, { entryDate: new Date("2026-09-20T12:00:00Z"), memo: "Loan in", sourceType: "manual", lines: [{ account: { key: "cash" }, debitCents: 1000, creditCents: 0 }, { account: { key: "owner_equity" }, debitCents: 0, creditCents: 1000 }] }));
    const jeBefore = qbo.JournalEntry.length;
    faults.dropConnection = true;
    const r1 = await exportToAccounting(WS, provider({ maxRetries: 0 }), { userId: USER });
    faults.dropConnection = false;
    assert.equal(r1.failed, 1);
    assert.equal(r1.failures[0]!.retryable, true);
    assert.ok(r1.stopped);
    const pending = (await exports()).find((e) => e.status === "pending")!;
    assert.equal(pending.attempt, 1);

    // The remote saves it but the response is lost (503) — liveRequest retries with the same requestid.
    faults.lostResponses = 1;
    const r2 = await exportToAccounting(WS, provider(), { userId: USER });
    assert.equal(r2.exported.length, 1);
    assert.equal(qbo.JournalEntry.length, jeBefore + 1, "exactly one remote journal");
    const keys = posts.filter((p) => p.entity === "journalentry").map((p) => p.requestid);
    assert.equal(new Set(keys).size, keys.length, "no requestid was posted twice");
  });

  it("two concurrent exports post a new document once", async () => {
    await withWorkspaceScope(WS, (tx) => postEntry(tx, actor, { entryDate: new Date("2026-09-21T12:00:00Z"), memo: "Concurrent", sourceType: "manual", lines: [{ account: { key: "cash" }, debitCents: 700, creditCents: 0 }, { account: { key: "owner_equity" }, debitCents: 0, creditCents: 700 }] }));
    const jeBefore = qbo.JournalEntry.length;
    const [a, b] = await Promise.all([exportToAccounting(WS, provider(), { userId: USER }), exportToAccounting(WS, provider(), { userId: USER })]);
    assert.equal(qbo.JournalEntry.length, jeBefore + 1);
    assert.equal(a.exported.length + b.exported.length + a.alreadyExported + b.alreadyExported >= 1, true);
    const rows = (await exports()).filter((e) => e.status === "exported" && e.docType === "journal_entry");
    assert.equal(new Set(rows.map((r) => r.remoteId)).size, rows.length, "each export row has its own remote document");
  });

  it("a definitive 400 marks it failed (attempt+1); after the fix a new requestid posts it once", async () => {
    await withWorkspaceScope(WS, async (tx) => {
      const bill = await tx.opsVendorBill.create({ data: { workspaceId: WS, vendorId: ids.vendor, number: "BILL-0002", lineItems: [{ description: "Toner", qty: 2, priceCents: 1500 }], subtotalCents: 3000, totalCents: 3000, status: "open", billDate: new Date("2026-09-22T12:00:00Z") } });
      ids.bill2 = bill.id;
      await postVendorBill(tx, actor, bill);
    });
    faults.rejectNextBill = true;
    const r1 = await exportToAccounting(WS, provider(), { userId: USER });
    assert.equal(r1.failures[0]?.retryable, false);
    assert.match(r1.failures[0]!.error, /Vendor is inactive/);
    const failed = (await exports()).find((e) => e.sourceKey === `bill:${ids.bill2}`)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempt, 2);
    const billsBefore = qbo.Bill.length;
    const r2 = await exportToAccounting(WS, provider(), { userId: USER });
    assert.deepEqual(r2.exported.map((e) => e.sourceKey), [`bill:${ids.bill2}`]);
    assert.equal(qbo.Bill.length, billsBefore + 1);
    assert.equal((await exports()).find((e) => e.sourceKey === `bill:${ids.bill2}`)!.status, "exported");
  });
});

describe("contacts import + ledger + isolation", () => {
  it("customers → contacts (by email), vendors → vendors (by name); re-import is a no-op", async () => {
    await withWorkspaceScope(WS, (tx) => tx.opsContact.create({ data: { workspaceId: WS, name: "Grace (local)", email: "grace@example.com" } }));
    const r1 = await importParties(WS, provider(), {});
    const l = await withWorkspaceScope(WS, async (tx) => ({
      contacts: await tx.opsContact.findMany({ where: { workspaceId: WS } }),
      vendors: await tx.opsVendor.findMany({ where: { workspaceId: WS } }),
    }));
    assert.equal(l.contacts.find((c) => c.email === "ada@example.com")?.name, "Ada Lovelace");
    assert.equal(l.contacts.filter((c) => c.email === "grace@example.com").length, 1);
    assert.equal(l.vendors.filter((v) => v.name === "Paper Co").length, 1, "vendor deduped by name");
    assert.equal(r1.linked, 1, "Grace deduped by email (Paper Co was already linked by the bill export)");
    assert.equal(r1.created, 1, "Ada");
    const r2 = await importParties(WS, provider(), {});
    assert.equal(r2.created + r2.updated, 0);
  });

  it("the ledger is byte-for-byte unchanged by exports and imports (only the test's own new postings were added)", async () => {
    const now = await ledger();
    const keep = new Set(ledgerBefore.entries.map((e) => e.id));
    assert.deepEqual(now.entries.filter((e) => keep.has(e.id)), ledgerBefore.entries);
    const keepLines = new Set(ledgerBefore.lines.map((l) => l.id));
    assert.deepEqual(now.lines.filter((l) => keepLines.has(l.id)), ledgerBefore.lines);
    // Posted entries stay immutable in the database itself.
    await assert.rejects(withWorkspaceScope(WS, (tx) => tx.opsJournalEntry.update({ where: { id: ids.manual }, data: { memo: "edited" } })));
  });

  it("mapping + export tables are FORCE RLS; nothing lands in another workspace", async () => {
    assert.equal(await countWithoutScope("ops_accounting_links"), 0);
    assert.equal(await countWithoutScope("ops_accounting_exports"), 0);
    const b = await withWorkspaceScope(WS_B, async (tx) => ({
      links: await tx.opsAccountingLink.count(),
      exports: await tx.opsAccountingExport.count(),
      contacts: await tx.opsContact.count({ where: { workspaceId: WS_B } }),
      vendors: await tx.opsVendor.count({ where: { workspaceId: WS_B } }),
      sync: await tx.bizSyncLink.count(),
    }));
    assert.deepEqual(b, { links: 0, exports: 0, contacts: 0, vendors: 0, sync: 0 });
    assert.ok((await withWorkspaceScope(WS, (tx) => tx.opsAccountingExport.count())) >= 8);
  });
});
