// ShapesOS Phase 10 (ops-core): leave accrual maths. Unit (no DB).
// Run: npx tsx --test lib/ops/__tests__/p10-hr.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accruedCentidays, businessDays, computeLeaveBalance } from "../leave";
import { OPS_ENTITY_MAP } from "../entities";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("leave accrual", () => {
  it("counts working days inclusive (Mon–Fri)", () => {
    assert.equal(businessDays(d("2026-10-05"), d("2026-10-09")), 5); // Mon–Fri
    assert.equal(businessDays(d("2026-10-03"), d("2026-10-04")), 0); // weekend
    assert.equal(businessDays(d("2026-10-09"), d("2026-10-12")), 2); // Fri + Mon
    assert.equal(businessDays(d("2026-10-12"), d("2026-10-09")), 0);
  });

  it("accrues yearly days monthly, pro rata from the start month, rounded down", () => {
    assert.equal(accruedCentidays(20, 2026, d("2026-12-31"), null), 2000);
    assert.equal(accruedCentidays(20, 2026, d("2026-01-15"), null), 166); // 1/12 of 20 = 1.666…
    assert.equal(accruedCentidays(24, 2026, d("2026-06-01"), d("2026-04-10")), 600); // Apr–Jun = 3 months × 2
    assert.equal(accruedCentidays(20, 2026, d("2026-06-01"), d("2027-01-01")), 0, "not started yet");
    assert.equal(accruedCentidays(20, 2025, d("2026-03-01"), null), 2000, "past years accrue in full");
  });

  it("carries unused days forward up to the cap", () => {
    const policy = { yearlyDays: 20, carryOverCapDays: 5 };
    // 2025: 20 accrued, 8 taken → 12 left, capped to 5 carried into 2026.
    const b = computeLeaveBalance(policy, d("2024-12-01"), [{ year: 2025, kind: "taken", centidays: 800 }], d("2026-03-15"));
    // 2024 (Dec only): 1.66 accrued → carried 1.66 into 2025 (under cap).
    assert.equal(b.year, 2026);
    assert.equal(b.carriedIn, 500);
    assert.equal(b.accrued, 500); // Jan–Mar of 20/yr
    assert.equal(b.available, 1000);
  });

  it("taken and adjustments move the balance; overdraft carries as debt", () => {
    const policy = { yearlyDays: 12, carryOverCapDays: 10 };
    const b = computeLeaveBalance(
      policy,
      null,
      [
        { year: 2025, kind: "taken", centidays: 1500 },
        { year: 2026, kind: "adjustment", centidays: 250 },
        { year: 2026, kind: "taken", centidays: 100 },
      ],
      d("2026-12-31"),
    );
    assert.equal(b.carriedIn, -300, "2025: 12 − 15 = −3 carried as debt");
    assert.equal(b.available, -300 + 1200 + 250 - 100);
  });

  it("ledger adjustments are append-only and in hundredths of a day", () => {
    const def = OPS_ENTITY_MAP["leave-ledger"]!;
    assert.equal(def.patchable, false);
    const ok = def.createSchema.safeParse({ memberId: "m", type: "vacation", year: 2026, days: -1.5 });
    assert.equal(ok.success, true);
    assert.deepEqual(ok.success && ok.data, { memberId: "m", type: "vacation", year: 2026, kind: "adjustment", centidays: -150, note: undefined });
    assert.equal(def.createSchema.safeParse({ memberId: "m", type: "vacation", year: 2026, days: 0.123 }).success, false);
  });
});
