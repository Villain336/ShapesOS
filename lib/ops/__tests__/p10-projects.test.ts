// ShapesOS Phase 10 (ops-core): billing maths for "invoice unbilled time". Unit.
// Run: npx tsx --test lib/ops/__tests__/p10-projects.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpsError } from "../doctype";
import { OPS_ENTITY_MAP } from "../entities";
import { billableAmountCents, timeInvoiceLines } from "../timesheets";

describe("time billing", () => {
  it("bills integer cents per minute at an hourly rate (half-up)", () => {
    assert.equal(billableAmountCents(60, 15000), 15000);
    assert.equal(billableAmountCents(90, 15000), 22500);
    assert.equal(billableAmountCents(1, 10000), 167); // 166.67 → 167
    assert.equal(billableAmountCents(0, 10000), 0);
  });

  it("groups per person and effective rate; entry rate beats project rate", () => {
    const lines = timeInvoiceLines(
      "Site",
      [
        { id: "e1", minutes: 60, userId: "u1", rateCents: null },
        { id: "e2", minutes: 30, userId: "u1", rateCents: null },
        { id: "e3", minutes: 60, userId: "u1", rateCents: 20000 },
        { id: "e4", minutes: 120, userId: "u2", rateCents: null },
      ],
      10000,
      (u) => (u === "u1" ? "Ann" : "Bob"),
    );
    assert.equal(lines.length, 3);
    const annBase = lines.find((l) => l.entryIds.includes("e1"))!;
    assert.deepEqual(annBase.entryIds, ["e1", "e2"]);
    assert.equal(annBase.priceCents, 15000);
    assert.equal(annBase.qty, 1);
    assert.match(annBase.description, /Ann: 1h 30m @ \$100\.00\/h/);
    assert.equal(lines.find((l) => l.entryIds.includes("e3"))!.priceCents, 20000);
    assert.equal(lines.find((l) => l.entryIds.includes("e4"))!.priceCents, 20000);
  });

  it("refuses to bill time with no rate rather than billing $0", () => {
    assert.throws(
      () => timeInvoiceLines("Site", [{ id: "e1", minutes: 60, userId: null, rateCents: null }], null, () => "x"),
      (e: unknown) => e instanceof OpsError && e.status === 422,
    );
  });

  it("tasks are a registered ops entity with a strict patch contract", () => {
    const t = OPS_ENTITY_MAP["tasks"]!;
    assert.equal(t.delegate, "opsTask");
    assert.equal(t.patchSchema.safeParse({ projectId: "p2" }).success, false, "tasks never move projects");
    assert.equal(t.patchSchema.safeParse({ stage: "in_progress" }).success, true);
    assert.equal(t.createSchema.safeParse({ projectId: "p", title: "x", stage: "nope" }).success, false);
  });
});
