// Phase 11 (bizsync): Xero pure pieces — documented payload transforms,
// /Date()/ parsing, error classification, tenant metadata, OAuth wiring.
// Run: npx tsx --test lib/bizsync/__tests__/xero.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { accountFromXero, billToXero, codeOf, journalToXero, partyFromXero, paymentToXero, salesToXero, xeroDateToIso, xeroQuote } from "../xero/map";
import { xeroClassify } from "../xero/api";
import { tenantsOf } from "../xero/tenants";
import { getOAuthConfig } from "@/lib/vault/oauth";
import { connectorAction, connectorGroup } from "@/lib/agents/grants";
import type { SalesDoc } from "../accounting/types";

const sales: SalesDoc = {
  kind: "invoice",
  number: "INV-0001",
  date: new Date("2026-10-01T15:00:00Z"),
  dueDate: null,
  customerRemoteId: "c-1",
  lines: [
    { description: "Design", qty: 2, unitCents: 5000, amountCents: 10000, taxCents: 1500, account: { id: "a-200", code: "200", name: "Sales" } },
    { description: "Rush fee", qty: 1, unitCents: 2500, amountCents: 2500, taxCents: 0, account: { id: "a-200", code: "200", name: "Sales" } },
  ],
  taxCents: 1500,
  totalCents: 14000,
};

describe("Xero payloads (documented shapes)", () => {
  it("accounts: Class → class, SystemAccount / BANK → role, archived inactive", () => {
    assert.deepEqual(accountFromXero({ AccountID: "a-610", Code: "610", Name: "Accounts Receivable", Type: "CURRENT", Class: "ASSET", Status: "ACTIVE", SystemAccount: "DEBTORS" }), { id: "a-610", code: "610", name: "Accounts Receivable", type: "CURRENT", cls: "asset", role: "ar", active: true });
    assert.equal(accountFromXero({ AccountID: "a-90", Code: "090", Name: "Business Bank", Type: "BANK", Class: "ASSET" })?.role, "bank");
    assert.equal(accountFromXero({ AccountID: "a-200", Code: "200", Name: "Sales", Type: "REVENUE", Class: "REVENUE" })?.cls, "income");
    assert.equal(accountFromXero({ AccountID: "a-1", Code: "1", Name: "Old", Type: "EXPENSE", Class: "EXPENSE", Status: "ARCHIVED" })?.active, false);
    assert.equal(accountFromXero({ AccountID: "x", Name: "No class" }), null);
  });

  it("contacts: /Date()/ timestamps, customer/supplier flags, default phone", () => {
    assert.equal(xeroDateToIso("/Date(1696000000000+0000)/"), "2023-09-29T15:06:40.000Z");
    assert.equal(xeroDateToIso("2026-10-01T00:00:00"), new Date("2026-10-01T00:00:00").toISOString());
    assert.equal(xeroDateToIso(undefined), "1970-01-01T00:00:00.000Z");
    const p = partyFromXero({ ContactID: "c-9", Name: "Paper Co", EmailAddress: "ap@paper.test", IsSupplier: true, Phones: [{ PhoneType: "MOBILE", PhoneNumber: "999" }, { PhoneType: "DEFAULT", PhoneNumber: "5550001", PhoneAreaCode: "512" }], TaxNumber: "12-345", UpdatedDateUTC: "/Date(1696000000000+0000)/" })!;
    assert.equal(p.isVendor, true);
    assert.equal(p.isCustomer, false);
    assert.equal(p.phone, "512 5550001");
    assert.equal(p.taxId, "12-345");
  });

  it("ACCREC invoice: Exclusive lines, AccountCode, per-line TaxAmount or TaxType NONE, AUTHORISED, due = date when unset", () => {
    const { path, body } = salesToXero(sales);
    assert.equal(path, "Invoices");
    assert.deepEqual(body, {
      Invoices: [{
        Type: "ACCREC",
        Contact: { ContactID: "c-1" },
        Date: "2026-10-01",
        DueDate: "2026-10-01",
        InvoiceNumber: "INV-0001",
        LineAmountTypes: "Exclusive",
        Status: "AUTHORISED",
        LineItems: [
          { Description: "Design", Quantity: 2, UnitAmount: 50, AccountCode: "200", TaxAmount: 15 },
          { Description: "Rush fee", Quantity: 1, UnitAmount: 25, AccountCode: "200", TaxType: "NONE" },
        ],
      }],
    });
    const cn = salesToXero({ ...sales, kind: "credit_note", number: "CN-0001", creditsRemoteId: "inv-9" });
    assert.equal(cn.path, "CreditNotes");
    const c = (cn.body.CreditNotes as Array<Record<string, unknown>>)[0]!;
    assert.equal(c.Type, "ACCRECCREDIT");
    assert.equal(c.CreditNoteNumber, "CN-0001");
    assert.equal(c.Reference, "Credits inv-9");
  });

  it("ACCPAY bill, payment, manual journal (+debit / −credit)", () => {
    const bill = billToXero({ number: "PC-77", date: new Date("2026-10-02"), dueDate: new Date("2026-11-01"), vendorRemoteId: "v-1", lines: [{ description: "Paper", qty: 1, unitCents: 1999, amountCents: 1999, taxCents: 0, account: { id: "a-429", code: "429", name: "General" } }], taxCents: 0, totalCents: 1999, memo: "ShapesOS BILL-0001" });
    const b = (bill.Invoices as Array<Record<string, unknown>>)[0]!;
    assert.equal(b.Type, "ACCPAY");
    assert.equal(b.InvoiceNumber, "PC-77");
    assert.equal(b.Reference, "ShapesOS BILL-0001");
    assert.deepEqual(paymentToXero({ kind: "payment", date: new Date("2026-10-03"), amountCents: 14000, cashAccount: { id: "a-90", code: "090", name: "Bank" }, targetRemoteId: "inv-1", partyRemoteId: "c-1", reference: "pi_1" }), {
      Payments: [{ Invoice: { InvoiceID: "inv-1" }, Account: { AccountID: "a-90" }, Date: "2026-10-03", Amount: 140, Reference: "pi_1" }],
    });
    assert.deepEqual(journalToXero({ date: new Date("2026-10-04"), memo: null, number: null, lines: [{ account: { id: "a-90", code: "090", name: "Bank" }, debitCents: 50000, creditCents: 0, description: null }, { account: { id: "a-970", code: "970", name: "Owner A Funds Introduced" }, debitCents: 0, creditCents: 50000, description: "Capital" }] }), {
      ManualJournals: [{ Narration: "ShapesOS journal entry", Date: "2026-10-04", Status: "POSTED", LineAmountTypes: "NoTax", JournalLines: [{ LineAmount: 500, AccountCode: "090" }, { LineAmount: -500, AccountCode: "970", Description: "Capital" }] }],
    });
    assert.throws(() => codeOf({ code: null, name: "Bank" }), /has no code/);
  });

  it("validation errors surface Xero's messages; 429/5xx retry; where literals are escaped", () => {
    const c = xeroClassify(400, { Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: [{ Message: "Account code '999' is not a valid code for this document." }] }] });
    assert.equal(c.code, "bad_request");
    assert.match(c.message ?? "", /Account code '999'/);
    assert.equal(xeroClassify(401, {}).authExpired, true);
    assert.equal(xeroClassify(429, {}).retryable, true);
    assert.equal(xeroClassify(503, {}).retryable, true);
    assert.equal(xeroQuote('Say "Hi" Ltd'), '"Say \\"Hi\\" Ltd"');
  });
});

describe("tenants + wiring", () => {
  it("tenant list is read back from connection meta defensively", () => {
    const list = [{ tenantId: "11111111-2222-3333-4444-555555555555", tenantName: "Demo Co", tenantType: "ORGANISATION" }];
    assert.deepEqual(tenantsOf({ xeroTenants: JSON.stringify(list) }), list);
    assert.deepEqual(tenantsOf({ xeroTenants: "not json" }), []);
    assert.deepEqual(tenantsOf(null), []);
  });

  it("Xero OAuth: Basic+form token auth and granular scopes; tools are ops / Tier-3 posting", () => {
    const cfg = getOAuthConfig("xero")!;
    assert.equal(cfg.tokenRequest, "form_basic");
    assert.ok(cfg.scopes.includes("offline_access") && cfg.scopes.includes("accounting.manualjournals"));
    assert.ok(!cfg.scopes.includes("accounting.transactions"));
    assert.equal(connectorGroup("xero"), "ops");
    assert.equal(connectorAction("xero", "post_to_xero"), "post_to_accounting");
    assert.equal(connectorAction("xero", "import_contacts"), "write_crm_record");
  });
});
