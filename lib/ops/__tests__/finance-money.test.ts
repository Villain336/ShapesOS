// ShapesOS — Phase 10 (finance): document money maths + numbering (PURE).
// Line tax, totals, balance due / partial-payment status, document numbers.
// Run: npx tsx --test lib/ops/__tests__/finance-money.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertApplicable,
  balanceDueCents,
  computeDocumentTotals,
  divRoundHalfUp,
  lineTaxCents,
  MoneyError,
  settledStatus,
} from "../finance/money";
import { formatDocumentNumber, hasFinanceLedger } from "../finance/numbering";

describe("line tax", () => {
  it("rounds half up per line, in integer maths", () => {
    assert.equal(lineTaxCents(1, 1_000, 825), 83); // 82.5 → 83
    assert.equal(lineTaxCents(1, 999, 825), 82); // 82.4175 → 82
    assert.equal(lineTaxCents(3, 333, 1_000), 100); // 99.9 → 100
    assert.equal(lineTaxCents(1, 1_000, 0), 0);
    assert.equal(divRoundHalfUp(5, 10), 1);
    assert.equal(divRoundHalfUp(4, 10), 0);
  });

  it("computes per-line tax from rates and ignores client taxCents on those lines", () => {
    const t = computeDocumentTotals(
      [
        { description: "A", qty: 2, priceCents: 1_000, taxRateId: "r1", taxCents: 999_999 },
        { description: "B", qty: 1, priceCents: 500 },
      ],
      new Map([["r1", 1_000]]),
      12_345,
    );
    assert.equal(t.subtotalCents, 2_500);
    assert.equal(t.taxCents, 200);
    assert.equal(t.totalCents, 2_700);
    assert.equal(t.lineTax, true);
    assert.equal(t.lineItems[0]!.taxCents, 200);
    assert.equal("taxCents" in t.lineItems[1]!, false);
  });

  it("keeps the free-entry document tax when no line has a rate (legacy)", () => {
    const t = computeDocumentTotals([{ qty: 1, priceCents: 1_000 }], new Map(), 75);
    assert.equal(t.taxCents, 75);
    assert.equal(t.totalCents, 1_075);
    assert.equal(t.lineTax, false);
  });

  it("an unknown or inactive rate is an error, never silently untaxed", () => {
    assert.throws(() => computeDocumentTotals([{ qty: 1, priceCents: 1, taxRateId: "gone" }], new Map()), MoneyError);
  });

  it("rejects totals beyond int4", () => {
    assert.throws(() => computeDocumentTotals([{ qty: 3, priceCents: 1_000_000_000 }], new Map()), /maximum/);
  });
});

describe("partial payments", () => {
  const inv = { status: "sent", totalCents: 10_000, paidCents: 0, creditedCents: 0 };
  it("balance due = total − paid − credited", () => {
    assert.equal(balanceDueCents(inv), 10_000);
    assert.equal(balanceDueCents({ ...inv, paidCents: 2_500, creditedCents: 1_000 }), 6_500);
  });
  it("status stays open on a partial payment and becomes paid at zero", () => {
    assert.equal(settledStatus({ ...inv, paidCents: 4_000 }), "sent");
    assert.equal(settledStatus({ ...inv, status: "overdue", paidCents: 4_000 }), "overdue");
    assert.equal(settledStatus({ ...inv, paidCents: 6_000, creditedCents: 4_000 }), "paid");
  });
  it("an applied amount must be positive whole cents and within the balance", () => {
    assert.doesNotThrow(() => assertApplicable(10_000, 10_000));
    assert.throws(() => assertApplicable(10_001, 10_000), /exceeds/);
    assert.throws(() => assertApplicable(0, 10_000), MoneyError);
    assert.throws(() => assertApplicable(1.5, 10_000), MoneyError);
  });
});

describe("document numbers", () => {
  it("pads to the sequence width and never truncates", () => {
    assert.equal(formatDocumentNumber("INV-", 1), "INV-0001");
    assert.equal(formatDocumentNumber("INV-", 42, 4), "INV-0042");
    assert.equal(formatDocumentNumber("CN-", 12_345, 4), "CN-12345");
    assert.equal(formatDocumentNumber("Q", 7, 0), "Q7");
    assert.throws(() => formatDocumentNumber("INV-", 0));
  });
  it("finance side effects only run on transactions that carry the ledger", () => {
    assert.equal(hasFinanceLedger({ opsInvoice: {} }), false);
    assert.equal(hasFinanceLedger({ $queryRaw: () => 1, opsJournalEntry: { createMany: () => 1 } }), true);
  });
});
