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

// Phase 2 regression cases (audit 2026-10-03 §5: WFH expense validation).
describe("validateExpense — strict inputs", () => {
  const base = {
    categoryKey: "internet",
    amountCents: 1000 as unknown,
    occurredOn: "2026-09-15" as Date | string,
    allocation: { method: "flat_percent" as const, percent: 50 },
  };
  const errs = (patch: Record<string, unknown>) => validateExpense({ ...base, ...patch }).errors;

  it("rejects half-cents, absurd amounts and non-numbers instead of rounding", () => {
    assert.match(errs({ amountCents: 0.5 }).join(), /whole number/);
    assert.match(errs({ amountCents: 1e15 }).join(), /at most/);
    assert.match(errs({ amountCents: 100_000_001 }).join(), /at most/);
    assert.match(errs({ amountCents: "1000" }).join(), /amountCents/);
    assert.match(errs({ amountCents: Number.NaN }).join(), /amountCents/);
    assert.equal(validateExpense({ ...base, amountCents: 100_000_000 }).ok, true);
  });

  it("rejects impossible calendar dates (no silent roll-over) and implausible years", () => {
    assert.match(errs({ occurredOn: "2026-02-30" }).join(), /not a real calendar date/);
    assert.match(errs({ occurredOn: "2026-13-01" }).join(), /not a real calendar date/);
    assert.match(errs({ occurredOn: "1900-01-01" }).join(), /year must be/);
    assert.match(errs({ occurredOn: "15/09/2026" }).join(), /YYYY-MM-DD/);
    assert.match(errs({ occurredOn: new Date("1999-12-31T12:00:00Z") }).join(), /year must be/);
    const leap = validateExpense({ ...base, occurredOn: "2024-02-29" });
    assert.equal(leap.ok, true);
    assert.equal(leap.normalized?.occurredOn.toISOString(), "2024-02-29T12:00:00.000Z");
    // The UI's full ISO timestamp still validates.
    assert.equal(validateExpense({ ...base, occurredOn: "2026-09-15T12:00:00.000Z" }).ok, true);
  });

  it("validates currency as an ISO-4217 string (a number is an error, not a crash)", () => {
    assert.doesNotThrow(() => validateExpense({ ...base, currency: 840 }));
    assert.match(errs({ currency: 840 }).join(), /ISO 4217/);
    assert.match(errs({ currency: "US" }).join(), /ISO 4217/);
    assert.match(errs({ currency: "ZZZ" }).join(), /ISO 4217/);
    assert.equal(validateExpense({ ...base, currency: "eur" }).normalized?.currency, "EUR");
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
