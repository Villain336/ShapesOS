// ShapesOS — Phase 10 (finance): accounting core unit tests (PURE — no DB).
// Balancing rules, the posting rule per document, tax maths and the report
// maths (trial balance, P&L, balance sheet).
// Run: npx tsx --test lib/ops/__tests__/accounting.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertBalanced,
  billPaymentLines,
  billPostLines,
  compactLines,
  creditNoteLines,
  expenseApproveLines,
  expenseReimburseLines,
  invoiceIssueLines,
  paymentReceivedLines,
  reversalLines,
  taxSplit,
  UnbalancedEntryError,
  type DraftLine,
} from "../accounting/rules";
import { balanceSheet, parseReportDate, profitAndLoss, trialBalance } from "../accounting/reports";
import { STANDARD_CHART, type AccountRow } from "../accounting/chart";

const key = (l: DraftLine) => ("key" in l.account ? l.account.key : `id:${l.account.id}`);
const debits = (ls: DraftLine[]) => Object.fromEntries(ls.filter((l) => l.debitCents > 0).map((l) => [key(l), l.debitCents]));
const credits = (ls: DraftLine[]) => Object.fromEntries(ls.filter((l) => l.creditCents > 0).map((l) => [key(l), l.creditCents]));

describe("balancing rules", () => {
  it("accepts a balanced two-line entry and returns its total", () => {
    assert.equal(assertBalanced([{ debitCents: 500, creditCents: 0 }, { debitCents: 0, creditCents: 500 }]), 500);
  });
  it("rejects unequal sides, one-line entries, two-sided and empty lines, negatives and fractions", () => {
    const bad: Array<Array<{ debitCents: number; creditCents: number }>> = [
      [{ debitCents: 500, creditCents: 0 }, { debitCents: 0, creditCents: 499 }],
      [{ debitCents: 500, creditCents: 0 }],
      [{ debitCents: 500, creditCents: 500 }, { debitCents: 0, creditCents: 0 }],
      [{ debitCents: 0, creditCents: 0 }, { debitCents: 0, creditCents: 0 }],
      [{ debitCents: -5, creditCents: 0 }, { debitCents: 0, creditCents: -5 }],
      [{ debitCents: 1.5, creditCents: 0 }, { debitCents: 0, creditCents: 1.5 }],
    ];
    for (const lines of bad) assert.throws(() => assertBalanced(lines), UnbalancedEntryError, JSON.stringify(lines));
  });
  it("rejects totals beyond the int4 money range", () => {
    assert.throws(() => assertBalanced([{ debitCents: 2_147_483_648, creditCents: 0 }, { debitCents: 0, creditCents: 2_147_483_648 }]), /exceeds/);
  });
  it("compactLines merges same account + side and drops zero lines", () => {
    const out = compactLines([
      { account: { key: "sales" }, debitCents: 0, creditCents: 100 },
      { account: { key: "sales" }, debitCents: 0, creditCents: 50 },
      { account: { key: "tax_payable" }, debitCents: 0, creditCents: 0 },
      { account: { key: "ar" }, debitCents: 150, creditCents: 0 },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.creditCents, 150);
  });
  it("a reversal swaps every side and still balances", () => {
    const lines = invoiceIssueLines({ totalCents: 1100, taxCents: 100, lineItems: [] });
    const rev = reversalLines(lines);
    assert.equal(assertBalanced(rev), 1100);
    assert.deepEqual(debits(rev), credits(lines));
  });
});

describe("posting rules per document", () => {
  it("invoice issued: Dr AR total, Cr Sales net, Cr Tax payable", () => {
    const l = invoiceIssueLines({ totalCents: 10_825, taxCents: 825, lineItems: [{ qty: 1, priceCents: 10_000 }] });
    assert.equal(assertBalanced(l), 10_825);
    assert.deepEqual(debits(l), { ar: 10_825 });
    assert.deepEqual(credits(l), { sales: 10_000, tax_payable: 825 });
  });
  it("invoice tax goes to the rate's own account when it has one", () => {
    const rates = new Map([["tr_ny", { id: "tr_ny", rateBps: 800, salesAccountId: "acc_ny" }]]);
    const l = invoiceIssueLines(
      { totalCents: 1_080 + 2_000, taxCents: 80, lineItems: [{ qty: 1, priceCents: 1_000, taxRateId: "tr_ny", taxCents: 80 }, { qty: 2, priceCents: 1_000 }] },
      rates,
    );
    assert.deepEqual(credits(l), { sales: 3_000, "id:acc_ny": 80 });
    assertBalanced(l);
  });
  it("an untaxed invoice has no tax line", () => {
    const l = invoiceIssueLines({ totalCents: 5_000, taxCents: 0, lineItems: [] });
    assert.equal(l.length, 2);
  });
  it("payment received: Dr Cash, Cr AR", () => {
    const l = paymentReceivedLines(2_500);
    assert.deepEqual(debits(l), { cash: 2_500 });
    assert.deepEqual(credits(l), { ar: 2_500 });
  });
  it("credit note mirrors the invoice: Dr Sales + Dr Tax, Cr AR", () => {
    const l = creditNoteLines({ totalCents: 1_100, taxCents: 100, lineItems: [] });
    assert.deepEqual(debits(l), { sales: 1_000, tax_payable: 100 });
    assert.deepEqual(credits(l), { ar: 1_100 });
  });
  it("vendor bill: Dr expense per line account, Dr input tax, Cr AP", () => {
    const l = billPostLines({
      totalCents: 3_300,
      taxCents: 300,
      lineItems: [
        { qty: 1, priceCents: 2_000, accountId: "acc_software" },
        { qty: 1, priceCents: 1_000 },
      ],
    });
    assert.equal(assertBalanced(l), 3_300);
    assert.deepEqual(debits(l), { "id:acc_software": 2_000, expense_general: 1_000, tax_receivable: 300 });
    assert.deepEqual(credits(l), { ap: 3_300 });
  });
  it("vendor bill uses the vendor's default account for lines without one", () => {
    const l = billPostLines({ totalCents: 1_000, taxCents: 0, lineItems: [{ qty: 1, priceCents: 1_000 }] }, new Map(), { id: "acc_rent" });
    assert.deepEqual(debits(l), { "id:acc_rent": 1_000 });
  });
  it("bill paid: Dr AP, Cr Cash", () => {
    const l = billPaymentLines(700);
    assert.deepEqual(debits(l), { ap: 700 });
    assert.deepEqual(credits(l), { cash: 700 });
  });
  it("expense claim approved: Dr category expense net + input tax, Cr reimbursements payable gross", () => {
    const l = expenseApproveLines([
      { category: "travel", amountCents: 12_000, taxCents: 2_000 },
      { category: "meals", amountCents: 3_000 },
      { category: "made-up", amountCents: 500 },
    ]);
    assert.equal(assertBalanced(l), 15_500);
    assert.deepEqual(debits(l), { expense_travel: 10_000, tax_receivable: 2_000, expense_meals: 3_000, expense_general: 500 });
    assert.deepEqual(credits(l), { reimbursements_payable: 15_500 });
  });
  it("expense reimbursed: Dr reimbursements payable, Cr Cash", () => {
    const l = expenseReimburseLines(15_500);
    assert.deepEqual(debits(l), { reimbursements_payable: 15_500 });
    assert.deepEqual(credits(l), { cash: 15_500 });
  });
  it("taxSplit sends document-level tax not covered by lines to the default account", () => {
    const parts = taxSplit([{ qty: 1, priceCents: 100, taxCents: 10 }], 25, new Map(), "sales");
    assert.deepEqual(parts.map((p) => p.cents), [10, 15]);
  });
});

// ---------------------------------------------------------------------------
// Report maths on a small, hand-checked ledger.
// ---------------------------------------------------------------------------

const ACCOUNTS: AccountRow[] = STANDARD_CHART.map((a) => ({
  id: a.code,
  code: a.code,
  name: a.name,
  type: a.type,
  parentId: null,
  systemKey: a.systemKey ?? null,
  active: true,
}));
const code = (k: string) => STANDARD_CHART.find((a) => a.systemKey === k)!.code;

function sumsOf(entries: DraftLine[][]): Map<string, { debitCents: number; creditCents: number }> {
  const m = new Map<string, { debitCents: number; creditCents: number }>();
  for (const e of entries) {
    assertBalanced(e);
    for (const l of e) {
      const id = "key" in l.account ? code(l.account.key) : l.account.id;
      const s = m.get(id) ?? { debitCents: 0, creditCents: 0 };
      s.debitCents += l.debitCents;
      s.creditCents += l.creditCents;
      m.set(id, s);
    }
  }
  return m;
}

// Owner puts in 10 000; invoice 11 000 incl. 1 000 tax; customer pays 6 000;
// bill 3 000 (rent); pays 3 000; expense claim 500 approved, not yet repaid.
const LEDGER = [
  [
    { account: { key: "cash" as const }, debitCents: 10_000, creditCents: 0 },
    { account: { key: "owner_equity" as const }, debitCents: 0, creditCents: 10_000 },
  ],
  invoiceIssueLines({ totalCents: 11_000, taxCents: 1_000, lineItems: [] }),
  paymentReceivedLines(6_000),
  billPostLines({ totalCents: 3_000, taxCents: 0, lineItems: [{ qty: 1, priceCents: 3_000 }] }, new Map(), { key: "expense_rent" }),
  billPaymentLines(3_000),
  expenseApproveLines([{ category: "meals", amountCents: 500 }]),
];

describe("report maths", () => {
  const sums = sumsOf(LEDGER);

  it("trial balance: debit and credit columns are equal", () => {
    const tb = trialBalance(ACCOUNTS, sums);
    assert.equal(tb.balanced, true);
    assert.equal(tb.totalDebitCents, tb.totalCreditCents);
    const cash = tb.rows.find((r) => r.code === code("cash"))!;
    assert.equal(cash.debitCents, 10_000 + 6_000 - 3_000);
    const ar = tb.rows.find((r) => r.code === code("ar"))!;
    assert.equal(ar.debitCents, 5_000);
  });

  it("P&L: income − expenses", () => {
    const pl = profitAndLoss(ACCOUNTS, sums);
    assert.equal(pl.totalIncomeCents, 10_000);
    assert.equal(pl.totalExpenseCents, 3_500);
    assert.equal(pl.netIncomeCents, 6_500);
    assert.deepEqual(pl.expenses.map((r) => r.code).sort(), [code("expense_meals"), code("expense_rent")].sort());
  });

  it("balance sheet: assets = liabilities + equity (with current earnings)", () => {
    const bs = balanceSheet(ACCOUNTS, sums);
    assert.equal(bs.totalAssetsCents, 13_000 + 5_000);
    assert.equal(bs.totalLiabilitiesCents, 1_000 + 500);
    assert.equal(bs.currentEarningsCents, 6_500);
    assert.equal(bs.totalEquityCents, 10_000 + 6_500);
    assert.equal(bs.balanced, true);
  });

  it("an empty ledger is balanced with no rows", () => {
    const tb = trialBalance(ACCOUNTS, new Map());
    assert.equal(tb.rows.length, 0);
    assert.equal(tb.balanced, true);
    assert.equal(balanceSheet(ACCOUNTS, new Map()).balanced, true);
  });

  it("report dates: YYYY-MM-DD 'to' covers the whole day; garbage is ignored", () => {
    assert.equal(parseReportDate("2026-10-31", true)!.toISOString(), "2026-10-31T23:59:59.999Z");
    assert.equal(parseReportDate("2026-10-01", false)!.toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(parseReportDate("nope", false), undefined);
    assert.equal(parseReportDate(null, false), undefined);
  });
});

describe("standard chart", () => {
  it("has unique codes and unique system keys, and every rule key exists", () => {
    const codes = STANDARD_CHART.map((a) => a.code);
    assert.equal(new Set(codes).size, codes.length);
    const keys = STANDARD_CHART.flatMap((a) => (a.systemKey ? [a.systemKey] : []));
    assert.equal(new Set(keys).size, keys.length);
    for (const k of ["cash", "ar", "ap", "sales", "tax_payable", "tax_receivable", "reimbursements_payable", "expense_general"]) {
      assert.ok(keys.includes(k as never), k);
    }
  });
});
