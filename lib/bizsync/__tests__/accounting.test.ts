// Phase 11 (bizsync): accounting pure pieces — account-mapping suggestions,
// the export plan (what each journal entry exports as), idempotency keys and
// failure classes, tax allocation, and the QuickBooks payload transforms
// (documented shapes). No network, no DB.
// Run: npx tsx --test lib/bizsync/__tests__/accounting.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { suggestMapping } from "../accounting/mapping";
import { allocateCents, idempotencyKey, isDefinitiveFailure, planExport } from "../accounting/export";
import type { RemoteAccount, SalesDoc } from "../accounting/types";
import { accountFromQbo, billToQbo, incomeItemName, journalToQbo, partyFromQbo, paymentToQbo, salesToQbo } from "../quickbooks/map";
import { qboClassify, qboQuote } from "../quickbooks/api";
import { ConnectorApiError } from "@/lib/connectors/m21/live/http";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { connectorAction, connectorGroup } from "@/lib/agents/grants";
import { getOAuthConfig } from "@/lib/vault/oauth";
import { parseDocTypes, parseSince } from "@/lib/connectors/m21/native/accounting";
import type { AccountRow } from "@/lib/ops/accounting";

const local = (id: string, code: string, name: string, type: AccountRow["type"], systemKey: string | null = null): AccountRow => ({ id, code, name, type, parentId: null, systemKey, active: true });
const remote = (id: string, name: string, cls: RemoteAccount["cls"], extra: Partial<RemoteAccount> = {}): RemoteAccount => ({ id, code: null, name, type: "T", cls, role: null, active: true, ...extra });

describe("account mapping suggestions", () => {
  const remoteChart = [
    remote("r1", "Checking", "asset", { role: "bank", type: "Bank" }),
    remote("r2", "Accounts Receivable (A/R)", "asset", { role: "ar" }),
    remote("r3", "Accounts Payable (A/P)", "liability", { role: "ap" }),
    remote("r4", "Sales of Product Income", "income"),
    remote("r5", "Rent & Lease", "expense", { code: "6100" }),
    remote("r6", "Office supplies", "expense"),
    remote("r7", "Old account", "expense", { active: false, code: "6900" }),
    remote("r8", "Sales", "asset", { code: "4000" }), // same code, wrong class → never by code
  ];

  it("code → system role → name → type fallback, classes always agree", () => {
    const s = suggestMapping(
      [
        local("l1", "1000", "Cash and bank", "asset", "cash"),
        local("l2", "1100", "Accounts receivable", "asset", "ar"),
        local("l3", "2000", "Accounts payable", "liability", "ap"),
        local("l4", "4000", "Sales", "income", "sales"),
        local("l5", "6100", "Rent", "expense", "expense_rent"),
        local("l6", "6400", "Office supplies", "expense", "expense_office"),
        local("l7", "6900", "Bank fees", "expense", "expense_bank_fees"),
      ],
      remoteChart,
    );
    const by = Object.fromEntries(s.map((x) => [x.accountId, [x.remote?.id ?? null, x.reason]]));
    assert.deepEqual(by.l1, ["r1", "system"]);
    assert.deepEqual(by.l2, ["r2", "system"]);
    assert.deepEqual(by.l3, ["r3", "system"]);
    assert.deepEqual(by.l4, ["r4", "type"], "sales → an income account named like sales (code 4000 is an asset there)");
    assert.deepEqual(by.l5, ["r5", "code"]);
    assert.deepEqual(by.l6, ["r6", "name"]);
    assert.deepEqual(by.l7, [null, null], "archived accounts are never suggested");
  });
});

describe("export plan", () => {
  const e = (sourceType: string, sourceId: string | null = "doc1", reversalOfId: string | null = null) => ({ id: "je1", sourceType, sourceId, reversalOfId });
  it("document postings export as their document, everything else as a journal", () => {
    for (const t of ["invoice", "credit_note", "bill", "payment", "bill_payment"]) {
      assert.deepEqual(planExport(e(t), { provider: "quickbooks" }), { docType: t, localId: "doc1", sourceKey: `${t}:doc1` });
    }
    for (const t of ["manual", "expense", "web_order"]) {
      assert.deepEqual(planExport(e(t, null), { provider: "xero" }), { docType: "journal_entry", localId: "je1", sourceKey: "journal:je1" });
    }
  });

  it("reversals: of a document → skipped (manual void); of an exported journal → journal; else skipped", () => {
    const rev = e("reversal", "orig", "orig");
    assert.match((planExport(rev, { provider: "quickbooks", original: { sourceType: "invoice" } }) as { skip: string }).skip, /void or credit that invoice in QuickBooks by hand/);
    assert.deepEqual(planExport(rev, { provider: "xero", original: { sourceType: "manual" }, originalExported: true }), { docType: "journal_entry", localId: "je1", sourceKey: "journal:je1" });
    assert.match((planExport(rev, { provider: "xero", original: { sourceType: "manual" }, originalExported: false }) as { skip: string }).skip, /was not exported/);
  });

  it("idempotency keys are stable per source + attempt and UUID-shaped", () => {
    const k1 = idempotencyKey("ws", "quickbooks", "invoice:1", 1);
    assert.equal(k1, idempotencyKey("ws", "quickbooks", "invoice:1", 1));
    assert.notEqual(k1, idempotencyKey("ws", "quickbooks", "invoice:1", 2));
    assert.notEqual(k1, idempotencyKey("ws", "xero", "invoice:1", 1));
    assert.notEqual(k1, idempotencyKey("ws2", "quickbooks", "invoice:1", 1));
    assert.match(k1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("only 4xx refusals are definitive (they bump the attempt); timeouts/5xx/auth retry with the same key", () => {
    assert.equal(isDefinitiveFailure(new ConnectorApiError("QuickBooks", "bad_request", "x")), true);
    assert.equal(isDefinitiveFailure(new ConnectorApiError("QuickBooks", "forbidden", "x")), true);
    for (const c of ["provider_error", "provider_unreachable", "rate_limited", "auth_rejected"] as const) {
      assert.equal(isDefinitiveFailure(new ConnectorApiError("QuickBooks", c, "x")), false, c);
    }
    assert.equal(isDefinitiveFailure(new Error("boom")), false);
  });

  it("tax allocation keeps whole cents and the exact total", () => {
    assert.deepEqual(allocateCents(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(allocateCents(7, [300, 100]), [5, 2]);
    assert.deepEqual(allocateCents(0, [5, 5]), [0, 0]);
    assert.deepEqual(allocateCents(9, [0, 0]), [9, 0]);
    for (const [t, w] of [[1999, [3, 7, 11]], [1, [5, 5, 5]]] as const) assert.equal(allocateCents(t, w).reduce((s, x) => s + x, 0), t);
  });

  it("tool args", () => {
    assert.deepEqual(parseDocTypes("invoice, bill"), ["invoice", "bill"]);
    assert.equal(parseDocTypes(""), undefined);
    assert.throws(() => parseDocTypes("everything"), /subset/);
    assert.equal(parseSince("2026-09-01")?.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.throws(() => parseSince("last week"), /date/);
  });
});

describe("QuickBooks payloads (documented shapes)", () => {
  it("accounts: class from Classification, roles from AccountType/SubType", () => {
    assert.deepEqual(accountFromQbo({ Id: "35", Name: "Checking", AccountType: "Bank", AccountSubType: "Checking", Classification: "Asset", Active: true }), { id: "35", code: null, name: "Checking", type: "Bank", cls: "asset", role: "bank", active: true });
    assert.equal(accountFromQbo({ Id: "84", Name: "A/R", AccountType: "Accounts Receivable", Classification: "Asset" })?.role, "ar");
    assert.equal(accountFromQbo({ Id: "1", Name: "Sales", AcctNum: "4000", AccountType: "Income", Classification: "Revenue" })?.cls, "income");
    assert.equal(accountFromQbo({ Id: "1", Name: "Sales", AcctNum: "4000", AccountType: "Income", Classification: "Revenue" })?.code, "4000");
    assert.equal(accountFromQbo({ Id: "9", Name: "Tax", AccountType: "Other Current Liability", AccountSubType: "GlobalTaxPayable", Classification: "Liability" })?.role, "tax");
    assert.equal(accountFromQbo({ Name: "no id" }), null);
  });

  it("parties: masked tax ids are dropped, address flattened", () => {
    const p = partyFromQbo({ Id: "7", DisplayName: "Acme Supplies", PrimaryEmailAddr: { Address: "ap@acme.test" }, TaxIdentifier: "XXX-XX-1234", BillAddr: { Line1: "1 Main", City: "Austin", CountrySubDivisionCode: "TX", PostalCode: "78701" }, MetaData: { LastUpdatedTime: "2026-10-01T10:00:00-07:00" } }, "vendor")!;
    assert.equal(p.taxId, null);
    assert.equal(p.address, "1 Main\nAustin TX 78701");
    assert.equal(p.isVendor, true);
    assert.equal(p.email, "ap@acme.test");
  });

  const acct = { id: "79", code: "4000", name: "Sales" };
  const sales: SalesDoc = {
    kind: "invoice",
    number: "INV-0001-THIS-IS-A-VERY-LONG-NUMBER",
    date: new Date("2026-10-01T15:00:00Z"),
    dueDate: new Date("2026-10-31T00:00:00Z"),
    customerRemoteId: "58",
    lines: [{ description: "Design", qty: 2, unitCents: 5000, amountCents: 10000, taxCents: 825, account: acct }],
    taxCents: 825,
    totalCents: 10825,
  };

  it("invoice: Service item per income account, DocNumber ≤ 21, tax total", () => {
    const body = salesToQbo(sales, (id) => (id === "79" ? "ITEM-1" : "?"));
    assert.deepEqual(body, {
      CustomerRef: { value: "58" },
      TxnDate: "2026-10-01",
      DueDate: "2026-10-31",
      DocNumber: "INV-0001-THIS-IS-A-VE",
      Line: [{ DetailType: "SalesItemLineDetail", Amount: 100, Description: "Design", SalesItemLineDetail: { ItemRef: { value: "ITEM-1" }, Qty: 2, UnitPrice: 50 } }],
      TxnTaxDetail: { TotalTax: 8.25 },
    });
    assert.equal(incomeItemName("Sales: Retail"), "ShapesOS sales — Sales  Retail");
  });

  it("bill, payment, bill payment, journal", () => {
    const bill = billToQbo({ number: "V-77", date: new Date("2026-10-02"), dueDate: null, vendorRemoteId: "12", lines: [{ description: "Paper", qty: 1, unitCents: 1999, amountCents: 1999, taxCents: 0, account: { id: "60", code: null, name: "Office" } }], taxCents: 0, totalCents: 1999, memo: "ShapesOS BILL-0001" });
    assert.deepEqual(bill.Line, [{ DetailType: "AccountBasedExpenseLineDetail", Amount: 19.99, Description: "Paper", AccountBasedExpenseLineDetail: { AccountRef: { value: "60" } } }]);
    assert.equal(bill.VendorRef && (bill.VendorRef as { value: string }).value, "12");
    const pay = paymentToQbo({ kind: "payment", date: new Date("2026-10-03"), amountCents: 10825, cashAccount: { id: "35", code: null, name: "Checking" }, targetRemoteId: "130", partyRemoteId: "58", reference: "pi_123" });
    assert.equal(pay.entity, "payment");
    assert.deepEqual(pay.body, { CustomerRef: { value: "58" }, TotalAmt: 108.25, TxnDate: "2026-10-03", DepositToAccountRef: { value: "35" }, PaymentRefNum: "pi_123", Line: [{ Amount: 108.25, LinkedTxn: [{ TxnId: "130", TxnType: "Invoice" }] }] });
    const bp = paymentToQbo({ kind: "bill_payment", date: new Date("2026-10-03"), amountCents: 1999, cashAccount: { id: "35", code: null, name: "Checking" }, targetRemoteId: "140", partyRemoteId: "12", reference: null });
    assert.equal(bp.entity, "billpayment");
    assert.deepEqual((bp.body as { CheckPayment: unknown }).CheckPayment, { BankAccountRef: { value: "35" } });
    assert.deepEqual((bp.body as { Line: unknown }).Line, [{ Amount: 19.99, LinkedTxn: [{ TxnId: "140", TxnType: "Bill" }] }]);
    const je = journalToQbo({ date: new Date("2026-10-04"), memo: "Owner contribution", number: null, lines: [{ account: { id: "35", code: null, name: "" }, debitCents: 50000, creditCents: 0, description: null }, { account: { id: "90", code: null, name: "" }, debitCents: 0, creditCents: 50000, description: "Capital" }] });
    assert.deepEqual(je, {
      TxnDate: "2026-10-04",
      PrivateNote: "Owner contribution",
      Line: [
        { DetailType: "JournalEntryLineDetail", Amount: 500, JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "35" } } },
        { DetailType: "JournalEntryLineDetail", Amount: 500, Description: "Capital", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "90" } } },
      ],
    });
  });

  it("fault envelope → closed codes; query literals are escaped", () => {
    const fault = { Fault: { Error: [{ Message: "Duplicate Name Exists Error", Detail: "The name supplied already exists.", code: "6240" }], type: "ValidationFault" } };
    const c = qboClassify(400, fault);
    assert.equal(c.code, "bad_request");
    assert.match(c.message ?? "", /Duplicate Name Exists Error — The name supplied already exists/);
    assert.equal(qboClassify(401, { Fault: { type: "AuthenticationFault" } }).authExpired, true);
    assert.equal(qboClassify(429, null).retryable, true);
    assert.equal(qboClassify(503, null).retryable, true);
    assert.equal(qboQuote("O'Brien \\ Co"), "'O\\'Brien \\\\ Co'");
  });
});

describe("gating + OAuth wiring", () => {
  it("posting the books is Tier 3 (never automated); contacts are a Tier-2 CRM write", () => {
    assert.equal(connectorGroup("quickbooks"), "ops");
    assert.equal(connectorAction("quickbooks", "post_to_quickbooks"), "post_to_accounting");
    assert.equal(connectorAction("quickbooks", "import_contacts"), "write_crm_record");
    const settings = { automationAllows: true, smallActionThresholdCents: 1_000_000, tier1Kinds: ["post_to_accounting"] } as never;
    assert.equal(evaluateTier({ kind: "post_to_accounting", description: "export invoices" }, settings), 3);
  });

  it("QuickBooks: Basic+form token auth, realmId from the callback", () => {
    const cfg = getOAuthConfig("quickbooks")!;
    assert.equal(cfg.tokenRequest, "form_basic");
    assert.deepEqual(cfg.scopes, ["com.intuit.quickbooks.accounting"]);
    assert.deepEqual(cfg.callbackMeta!({ realmId: "9130350000000000" }, {} as never), { realmId: "9130350000000000", label: "QuickBooks company 9130350000000000" });
    assert.deepEqual(cfg.callbackMeta!({ realmId: "../x" }, {} as never), {});
  });
});
