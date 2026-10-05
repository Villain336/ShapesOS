// Phase 11 (bizsync): Xero against Postgres (app role) with a FAKE Xero
// (in-memory; it honours Idempotency-Key the way Xero documents it — a
// repeated key returns the original response). A labelled test fake: the
// live API is UNVERIFIED-LIVE.
//   1. Tenants: discovered after connect (first selected, id in the encrypted
//      payload), a person switches to another granted one, others refused.
//   2. One mapping table for both providers (keyed by provider).
//   3. Export once per source (re-export = zero PUTs; a lost response retries
//      with the same Idempotency-Key → one remote document).
//   4. Contacts: IsCustomer → contacts, IsSupplier → vendors (both when both).
//   5. The ledger is unchanged; mapping/export rows are FORCE RLS.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/bizsync/__tests__/xero-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import { countWithoutScope, withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { publicResolve } from "@/lib/connectors/m21/live/__tests__/fixtures";
import { getDecryptedCredential } from "@/lib/vault/refresh";
import { ensureChartOfAccounts, postEntry } from "@/lib/ops/accounting";
import { postInvoiceIssued, postInvoicePayment } from "@/lib/ops/finance/posting";
import { confirmMapping, mappingRows, saveSuggestions } from "../accounting/mapping";
import { exportToAccounting } from "../accounting/export";
import { importParties } from "../accounting/contacts";
import { xeroProvider } from "../xero/provider";
import { recordXeroTenants, selectXeroTenant, tenantsOf } from "../xero/tenants";
import type { OpsActor } from "@/lib/ops/doctype";
import { bizSyncStatus } from "../status";
import { recordRun } from "../links";

const RUN = `p11x-${Date.now().toString(36)}`;
const WS = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
const actor: OpsActor = { workspaceId: WS, userId: USER };
const T1 = "11111111-2222-3333-4444-555555555555";
const T2 = "66666666-7777-8888-9999-000000000000";

// FAKE Xero (tests only).
const xero = {
  Accounts: [
    { AccountID: "a-090", Code: "090", Name: "Business Bank Account", Type: "BANK", Class: "ASSET", Status: "ACTIVE" },
    { AccountID: "a-610", Code: "610", Name: "Accounts Receivable", Type: "CURRENT", Class: "ASSET", Status: "ACTIVE", SystemAccount: "DEBTORS" },
    { AccountID: "a-800", Code: "800", Name: "Accounts Payable", Type: "CURRLIAB", Class: "LIABILITY", Status: "ACTIVE", SystemAccount: "CREDITORS" },
    { AccountID: "a-200", Code: "200", Name: "Sales", Type: "REVENUE", Class: "REVENUE", Status: "ACTIVE" },
    { AccountID: "a-970", Code: "970", Name: "Owner A Funds Introduced", Type: "EQUITY", Class: "EQUITY", Status: "ACTIVE" },
  ],
  Contacts: [
    { ContactID: "c-1", Name: "Ada Lovelace", EmailAddress: "ada@example.com", IsCustomer: true, IsSupplier: false, UpdatedDateUTC: "/Date(1756000000000+0000)/" },
    { ContactID: "c-2", Name: "Paper Co", EmailAddress: "ap@paper.test", IsCustomer: false, IsSupplier: true, UpdatedDateUTC: "/Date(1756000000000+0000)/" },
    { ContactID: "c-3", Name: "Both Ways Ltd", EmailAddress: "both@example.com", IsCustomer: true, IsSupplier: true, UpdatedDateUTC: "/Date(1756000000000+0000)/" },
  ] as Array<Record<string, unknown>>,
  Invoices: [] as Array<Record<string, unknown>>,
  Payments: [] as Array<Record<string, unknown>>,
  ManualJournals: [] as Array<Record<string, unknown>>,
};
const byKey = new Map<string, string>();
const puts: Array<{ path: string; key: string; tenant: string }> = [];
let lostResponses = 0;
let n = 0;

const fakeXero = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const h = new Headers(init?.headers);
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  assert.equal(h.get("authorization"), "Bearer xero-token");
  if (url.href === "https://api.xero.com/connections") {
    return json(200, [
      { id: "conn-1", tenantId: T1, tenantType: "ORGANISATION", tenantName: "Demo Co (US)" },
      { id: "conn-2", tenantId: T2, tenantType: "ORGANISATION", tenantName: "Second Co" },
      { id: "conn-3", tenantId: "99999999-9999-9999-9999-999999999999", tenantType: "PRACTICE", tenantName: "Practice" },
    ]);
  }
  assert.equal(h.get("xero-tenant-id"), T1);
  const path = url.pathname.replace("/api.xro/2.0/", "");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET") {
    if (path === "Accounts") return json(200, { Accounts: xero.Accounts });
    const where = url.searchParams.get("where") ?? "";
    let rows = xero.Contacts;
    if (where === "IsCustomer==true") rows = rows.filter((c) => c.IsCustomer);
    else if (where === "IsSupplier==true") rows = rows.filter((c) => c.IsSupplier);
    else if (where.startsWith("Name==")) rows = rows.filter((c) => JSON.stringify(c.Name) === where.slice(6));
    else if (where.startsWith("EmailAddress==")) rows = rows.filter((c) => JSON.stringify(c.EmailAddress) === where.slice(14));
    const page = Number(url.searchParams.get("page") ?? 1);
    return json(200, { Contacts: page > 1 ? [] : rows });
  }
  const key = h.get("idempotency-key") ?? "";
  assert.ok(key, "every create carries an Idempotency-Key");
  const prior = byKey.get(key);
  if (prior) return new Response(prior, { status: 200, headers: { "content-type": "application/json" } });
  puts.push({ path, key, tenant: h.get("xero-tenant-id") ?? "" });
  const body = JSON.parse(String(init?.body)) as Record<string, Array<Record<string, unknown>>>;
  const doc = { ...body[path]![0]! };
  const idKey = { Contacts: "ContactID", Invoices: "InvoiceID", Payments: "PaymentID", ManualJournals: "ManualJournalID" }[path]!;
  doc[idKey] = `${path.toLowerCase()}-${++n}`;
  (xero[path as keyof typeof xero] as Array<Record<string, unknown>>).push(doc);
  const response = JSON.stringify({ [path]: [doc] });
  byKey.set(key, response);
  if (lostResponses > 0) {
    lostResponses -= 1;
    return json(503, { Title: "Service Unavailable" });
  }
  return new Response(response, { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const deps = { fetchImpl: fakeXero, resolve: publicResolve, sleep: async () => undefined };
const provider = () => xeroProvider({ tenantId: T1, token: { token: "xero-token" } }, deps);
const ids: Record<string, string> = {};

before(async () => {
  for (const id of [WS, WS_B]) await prisma.workspace.create({ data: { id, name: `P11 ${id}`, ownerUserId: USER } });
  await withWorkspaceScope(WS, async (tx) => {
    await ensureChartOfAccounts(tx, WS);
    const inv = await tx.opsInvoice.create({ data: { workspaceId: WS, lineItems: [{ description: "Design", qty: 1, priceCents: 12000 }], taxCents: 0, totalCents: 12000, status: "sent", number: "INV-0100", sentAt: new Date("2026-09-10T12:00:00Z"), customerEmail: "ada@example.com" } });
    ids.invoice = inv.id;
    await postInvoiceIssued(tx, actor, inv);
    const pay = await tx.opsPayment.create({ data: { workspaceId: WS, invoiceId: inv.id, amountCents: 12000, kind: "charge", status: "succeeded", provider: "manual", createdAt: new Date("2026-09-12T12:00:00Z") } });
    await postInvoicePayment(tx, actor, { id: pay.id, amountCents: 12000, invoiceId: inv.id, createdAt: pay.createdAt });
    ids.manual = (await postEntry(tx, actor, { entryDate: new Date("2026-09-14T12:00:00Z"), memo: "Owner contribution", sourceType: "manual", lines: [{ account: { key: "cash" }, debitCents: 50000, creditCents: 0 }, { account: { key: "owner_equity" }, debitCents: 0, creditCents: 50000 }] })).entry.id;
  });
});

after(async () => {
  for (const id of [WS, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("Xero tenants", () => {
  it("discovers organisations after connect, selects the first, and only switches within the grant", async () => {
    const conn = await prisma.connectorConnection.create({ data: { workspaceId: WS, userId: USER, connectorKey: "xero", status: "active", scopes: [], meta: {} } });
    await prisma.connectorCredential.create({ data: { connectionId: conn.id, encryptedBlob: secrets().encrypt(JSON.stringify({ access_token: "xero-token", refresh_token: "r" })), keyVersion: "env-v1" } });
    const list = await recordXeroTenants(conn, deps);
    assert.deepEqual(list.map((t) => t.tenantId), [T1, T2], "practice tenants are not accounting files");
    let row = await prisma.connectorConnection.findUniqueOrThrow({ where: { id: conn.id } });
    assert.equal((row.meta as Record<string, string>).tenantId, T1);
    assert.equal((row.meta as Record<string, string>).label, "Demo Co (US)");
    assert.equal(tenantsOf(row.meta).length, 2);
    assert.equal((await getDecryptedCredential(conn.id))!.payload.tenantId, T1);

    assert.deepEqual(await selectXeroTenant(WS, T2), { ok: true, tenantName: "Second Co" });
    assert.equal((await getDecryptedCredential(conn.id))!.payload.tenantId, T2);
    assert.equal((await getDecryptedCredential(conn.id))!.payload.access_token, "xero-token", "the token survives the switch");
    const refused = await selectXeroTenant(WS, "99999999-9999-9999-9999-999999999999");
    assert.equal(refused.ok, false);
    assert.equal((await selectXeroTenant(WS_B, T1)).ok, false, "another workspace has no Xero connection");
    await selectXeroTenant(WS, T1);
    row = await prisma.connectorConnection.findUniqueOrThrow({ where: { id: conn.id } });
    assert.equal((row.meta as Record<string, string>).tenantId, T1);
  });
});

describe("Xero export", () => {
  it("shares the mapping table with QuickBooks (keyed by provider)", async () => {
    const rows = await mappingRows(WS, "xero");
    const sales = rows.find((r) => r.account.systemKey === "sales")!;
    await withWorkspaceScope(WS, (tx) => tx.opsAccountingLink.create({ data: { workspaceId: WS, provider: "quickbooks", accountId: sales.account.id, remoteAccountId: "79", remoteName: "Sales of Product Income", status: "confirmed" } }));
    const remote = await provider().listAccounts();
    await saveSuggestions(WS, "xero", remote);
    const after = await mappingRows(WS, "xero");
    assert.equal(after.find((r) => r.account.id === sales.account.id)?.link?.remoteAccountId, "a-200");
    const both = await withWorkspaceScope(WS, (tx) => tx.opsAccountingLink.findMany({ where: { workspaceId: WS, accountId: sales.account.id } }));
    assert.deepEqual(both.map((b) => b.provider).sort(), ["quickbooks", "xero"]);
    const equity = after.find((r) => r.account.systemKey === "owner_equity")!;
    const entries = after.filter((r) => r.link).map((r) => ({ accountId: r.account.id, remoteAccountId: r.link!.remoteAccountId }));
    entries.push({ accountId: equity.account.id, remoteAccountId: "a-970" });
    await confirmMapping(WS, "xero", entries, remote, USER);
  });

  it("posts each source once with an Idempotency-Key; re-export is a no-op", async () => {
    const before = await withWorkspaceScope(WS, async (tx) => ({ e: await tx.opsJournalEntry.findMany({ where: { workspaceId: WS }, orderBy: { id: "asc" } }), l: await tx.opsJournalLine.findMany({ where: { workspaceId: WS }, orderBy: { id: "asc" } }) }));
    const r = await exportToAccounting(WS, provider(), { userId: USER });
    assert.deepEqual(r.exported.map((e) => e.sourceKey.split(":")[0]), ["invoice", "payment", "journal"]);
    assert.equal(r.failed, 0);
    const inv = xero.Invoices[0]!;
    assert.equal(inv.Type, "ACCREC");
    assert.equal(inv.InvoiceNumber, "INV-0100");
    assert.deepEqual((inv.LineItems as Array<Record<string, unknown>>)[0], { Description: "Design", Quantity: 1, UnitAmount: 120, AccountCode: "200", TaxType: "NONE" });
    assert.equal((inv.Contact as { ContactID: string }).ContactID, "c-1", "the existing Xero contact with the invoice's email is reused");
    assert.equal(puts.filter((p) => p.path === "Contacts").length, 0, "no duplicate contact created");
    assert.deepEqual((xero.Payments[0]!.Invoice as Record<string, string>).InvoiceID, inv.InvoiceID);
    assert.deepEqual((xero.ManualJournals[0]!.JournalLines as Array<Record<string, unknown>>).map((l) => [l.AccountCode, l.LineAmount]), [["090", 500], ["970", -500]]);
    const count = puts.length;
    const again = await exportToAccounting(WS, provider(), { userId: USER });
    assert.equal(again.exported.length, 0);
    assert.equal(again.alreadyExported, 3);
    assert.equal(puts.length, count);
    const nowLedger = await withWorkspaceScope(WS, async (tx) => ({ e: await tx.opsJournalEntry.findMany({ where: { workspaceId: WS }, orderBy: { id: "asc" } }), l: await tx.opsJournalLine.findMany({ where: { workspaceId: WS }, orderBy: { id: "asc" } }) }));
    assert.deepEqual(nowLedger, before, "the ledger is untouched by the export");
  });

  it("a lost response is retried with the same key — one remote journal", async () => {
    await withWorkspaceScope(WS, (tx) => postEntry(tx, actor, { entryDate: new Date("2026-09-20T12:00:00Z"), memo: "Loan in", sourceType: "manual", lines: [{ account: { key: "cash" }, debitCents: 1000, creditCents: 0 }, { account: { key: "owner_equity" }, debitCents: 0, creditCents: 1000 }] }));
    const before = xero.ManualJournals.length;
    lostResponses = 1;
    const r = await exportToAccounting(WS, provider(), { userId: USER });
    assert.equal(r.exported.length, 1);
    assert.equal(xero.ManualJournals.length, before + 1);
  });
});

describe("Xero contacts + isolation", () => {
  it("customers → contacts, suppliers → vendors (a contact can be both); re-import is a no-op", async () => {
    const r1 = await importParties(WS, provider());
    const l = await withWorkspaceScope(WS, async (tx) => ({ contacts: await tx.opsContact.findMany({ where: { workspaceId: WS } }), vendors: await tx.opsVendor.findMany({ where: { workspaceId: WS } }) }));
    assert.deepEqual(l.contacts.map((c) => c.email).sort(), ["ada@example.com", "both@example.com"]);
    assert.deepEqual(l.vendors.map((v) => v.name).sort(), ["Both Ways Ltd", "Paper Co"]);
    assert.equal(r1.created, 4);
    const r2 = await importParties(WS, provider());
    assert.equal(r2.created + r2.updated, 0);
    assert.equal(r2.unchanged, 4);
  });

  it("the Business sync page status: connection label, organisations, export counts, last error", async () => {
    await assert.rejects(recordRun(WS, "xero", "export", USER, async () => { throw new Error("Xero request failed (HTTP 401)"); }));
    const xs = (await bizSyncStatus(WS)).find((p) => p.provider === "xero")!;
    assert.equal(xs.connection?.label, "Demo Co (US)");
    assert.deepEqual(xs.tenants?.map((t) => t.tenantName), ["Demo Co (US)", "Second Co"]);
    assert.equal(xs.tenantId, T1);
    assert.equal(xs.exports?.exported, 4);
    assert.equal(xs.lastError?.operation, "export");
    assert.ok((xs.links.customer ?? 0) >= 2);
    const other = await bizSyncStatus(WS_B);
    assert.ok(other.every((p) => p.connection === null && p.runs.length === 0 && (p.exports?.exported ?? 0) === 0));
  });

  it("FORCE RLS; nothing in the other workspace", async () => {
    assert.equal(await countWithoutScope("ops_accounting_links"), 0);
    assert.equal(await countWithoutScope("ops_accounting_exports"), 0);
    const b = await withWorkspaceScope(WS_B, async (tx) => ({ links: await tx.opsAccountingLink.count(), exports: await tx.opsAccountingExport.count(), vendors: await tx.opsVendor.count({ where: { workspaceId: WS_B } }) }));
    assert.deepEqual(b, { links: 0, exports: 0, vendors: 0 });
  });
});
