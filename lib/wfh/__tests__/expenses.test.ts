// Marketr — Wave 2 WFH mode slice 6: expense pack domain tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateAllocationRule,
  validateExpense,
  recomputeDeductible,
  toLedgerEntry,
  EXPENSE_CATEGORY_PRESETS,
} from "../expenses";

describe("validateAllocationRule", () => {
  it("accepts a flat percent", () => {
    const r = validateAllocationRule({ method: "flat_percent", percent: 15 });
    assert.equal(r.ok, true);
    assert.equal(r.normalized?.percent, 15);
  });

  it("derives percent from square footage", () => {
    const r = validateAllocationRule({ method: "square_footage", officeSqft: 120, totalSqft: 1200 });
    assert.equal(r.ok, true);
    assert.equal(r.normalized?.percent, 10);
  });

  it("rejects bad percents and impossible square footage", () => {
    assert.equal(validateAllocationRule({ method: "flat_percent", percent: 101 }).ok, false);
    assert.equal(validateAllocationRule({ method: "flat_percent", percent: -1 }).ok, false);
    assert.equal(
      validateAllocationRule({ method: "square_footage", officeSqft: 1300, totalSqft: 1200 }).ok,
      false,
    );
    assert.equal(validateAllocationRule({ method: "hourly" as never }).ok, false);
  });
});

describe("validateExpense", () => {
  it("computes the deductible portion from the allocation", () => {
    const v = validateExpense({
      categoryKey: "internet",
      amountCents: 8999, // $89.99
      occurredOn: new Date(2026, 8, 15),
      allocation: { method: "flat_percent", percent: 50 },
      note: "September bill",
    });
    assert.equal(v.ok, true);
    assert.equal(v.normalized?.deductibleCents, 4500); // 8999 × 50% = 4499.5 → 4500
    assert.equal(v.normalized?.currency, "USD");
  });

  it("applies the preset default method for square-footage categories", () => {
    const preset = EXPENSE_CATEGORY_PRESETS.find((p) => p.key === "home-office-space");
    assert.equal(preset?.defaultMethod, "square_footage");
  });

  it("rejects unknown categories, bad amounts, future dates, bad receipt URLs", () => {
    const v = validateExpense({
      categoryKey: "yacht",
      amountCents: -5,
      occurredOn: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      allocation: { method: "flat_percent", percent: 50 },
      receiptUrl: "notaurl",
    });
    assert.equal(v.ok, false);
    assert.ok(v.errors.length >= 4);
  });
});

describe("recomputeDeductible / toLedgerEntry", () => {
  it("recomputes after an allocation change", () => {
    assert.equal(recomputeDeductible(10000, 15), 1500);
    assert.equal(recomputeDeductible(8999, 50), 4500);
  });

  it("maps a stored expense to the ledger post-hook shape", () => {
    const entry = toLedgerEntry({
      id: "exp1",
      categoryKey: "internet",
      categoryName: "Internet",
      amountCents: 8999,
      currency: "USD",
      occurredOn: new Date("2026-09-15T12:00:00Z"),
      deductibleCents: 4500,
      allocationPct: 50,
      allocationMethod: "flat_percent",
      note: "September bill",
      receiptUrl: null,
      workspaceId: "ws1",
      userId: "u1",
    });
    assert.equal(entry.externalId, "wfh-expense:exp1");
    assert.equal(entry.source, "wfh-expense-pack");
    assert.equal(entry.category, "home-office:internet");
    assert.equal(entry.metadata.deductibleCents, 4500);
  });
});
