// ShapesOS Phase 12 (mfgpos): manufacturing rules (pure) — MO state machine,
// consumption/production quantities incl. scrap and partial runs, costing
// maths, routing ordering, the work-order timer, and the WIP/finish journal
// lines (balanced, WIP nets to zero).
//   npx tsx --test lib/ops/__tests__/p12-mfg.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertMoTransition,
  canMoveMo,
  completionQuantities,
  componentsFromBom,
  consumption,
  consumptionQty,
  hasCapacity,
  labourCents,
  moCosting,
  orderOperations,
  plannedWorkOrders,
  timerStep,
  MO_TRANSITIONS,
} from "../mfg/rules";
import { assertBalanced, moFinishLines, moWipLines, scrapLines } from "../accounting/rules";
import { OpsError } from "../doctype";
import { OPS_ENTITY_MAP } from "../entities";
import { classifyOpsWrite } from "../gate";

const is409 = (e: unknown) => e instanceof OpsError && e.status === 409;
const is422 = (e: unknown) => e instanceof OpsError && e.status === 422;

describe("MO state machine", () => {
  it("draft → confirmed → in_progress → done; cancel until done; done/cancelled are terminal", () => {
    assert.ok(canMoveMo("draft", "confirmed"));
    assert.ok(canMoveMo("confirmed", "in_progress"));
    assert.ok(canMoveMo("confirmed", "done"), "a one-step job can complete straight from confirmed");
    assert.ok(canMoveMo("in_progress", "done"));
    for (const s of ["draft", "confirmed", "in_progress"]) assert.ok(canMoveMo(s, "cancelled"), s);
    assert.ok(!canMoveMo("draft", "done"), "a draft has no component snapshot — confirm first");
    assert.ok(!canMoveMo("draft", "in_progress"));
    assert.deepEqual(MO_TRANSITIONS.done, []);
    assert.deepEqual(MO_TRANSITIONS.cancelled, []);
    assert.throws(() => assertMoTransition("done", "done"), is409);
    assert.throws(() => assertMoTransition("cancelled", "confirmed"), is409);
  });

  it("the entity registry gates confirm and complete, and uses the same table", () => {
    const def = OPS_ENTITY_MAP["manufacturing-orders"]!;
    assert.deepEqual(def.statusTransitions, MO_TRANSITIONS);
    assert.equal(classifyOpsWrite({ entity: "manufacturing-orders", op: "update", body: { id: "m", status: "confirmed" } }).slug, "OPS_MO_CONFIRM");
    assert.equal(classifyOpsWrite({ entity: "manufacturing-orders", op: "update", body: { id: "m", status: "done", producedQty: 3 } }).slug, "OPS_MO_COMPLETE");
    assert.equal(classifyOpsWrite({ entity: "manufacturing-orders", op: "update", body: { id: "m", status: "in_progress" } }).mode, "free");
    assert.equal(classifyOpsWrite({ entity: "manufacturing-orders", op: "create", body: { productId: "p", qty: 1 } }).mode, "free", "drafting an MO is free");
    assert.equal(classifyOpsWrite({ entity: "scraps", op: "create", body: { productId: "p", qty: 1, reason: "x" } }).slug, "OPS_SCRAP_POST");
  });
});

describe("routing ordering", () => {
  const wc = "wc1";
  it("sorts operations by sequence and scales planned minutes by quantity", () => {
    const ops = [
      { sequence: 30, name: "Pack", workCenterId: wc, plannedMinutes: 2 },
      { sequence: 10, name: "Cut", workCenterId: wc, plannedMinutes: 5 },
      { sequence: 20, name: "Weld", workCenterId: wc, plannedMinutes: 8 },
    ];
    assert.deepEqual(orderOperations(ops).map((o) => o.name), ["Cut", "Weld", "Pack"]);
    assert.deepEqual(plannedWorkOrders(ops, 4).map((o) => o.plannedMinutes), [20, 32, 8]);
  });
  it("rejects duplicate sequences, negative sequences and nameless steps", () => {
    assert.throws(() => orderOperations([{ sequence: 1, name: "A", workCenterId: wc, plannedMinutes: 1 }, { sequence: 1, name: "B", workCenterId: wc, plannedMinutes: 1 }]), is422);
    assert.throws(() => orderOperations([{ sequence: -1, name: "A", workCenterId: wc, plannedMinutes: 1 }]), is422);
    assert.throws(() => orderOperations([{ sequence: 1, name: " ", workCenterId: wc, plannedMinutes: 1 }]), is422);
    assert.throws(() => orderOperations([{ sequence: 1, name: "A", workCenterId: wc, plannedMinutes: 1.5 }]), is422);
  });
});

describe("components from the CAD BOM", () => {
  it("maps BOM lines through the CAD part's product link; unlinked lines carry cost but no stock move", () => {
    const comps = componentsFromBom([
      { id: "l1", partName: "Bolt", qty: 4, unitCostUsd: 0.125, productId: "p-bolt", productSku: "BOLT", trackInventory: true },
      { id: "l2", partName: "Paint", qty: 0.25, unitCostUsd: 12, productId: null, partSku: "PNT" },
      { id: "l3", partName: "Ghost", qty: 0, unitCostUsd: 1, productId: "p-x" },
      { id: "l4", partName: "Label", qty: 1, unitCostUsd: null, productId: "p-label", trackInventory: false },
    ]);
    assert.equal(comps.length, 3, "zero-quantity lines are dropped");
    assert.deepEqual(comps[0], { bomLineId: "l1", productId: "p-bolt", name: "Bolt", sku: "BOLT", qtyPerUnit: 4, unitCostCents: 13, stocked: true });
    assert.equal(comps[1]!.stocked, false);
    assert.equal(comps[1]!.sku, "PNT");
    assert.equal(comps[1]!.unitCostCents, 1200);
    assert.equal(comps[2]!.stocked, false, "a product that doesn't track inventory is not moved");
    assert.equal(comps[2]!.unitCostCents, 0, "unknown cost counts as 0");
  });
});

describe("consumption and production quantities", () => {
  it("rounds fractional per-unit quantities up to whole units, without float noise", () => {
    assert.equal(consumptionQty(4, 10), 40);
    assert.equal(consumptionQty(0.1, 30), 3, "0.1 × 30 is 3, not 4");
    assert.equal(consumptionQty(0.25, 3), 1);
    assert.equal(consumptionQty(2, 0), 0);
  });

  it("full, partial and scrapped completions", () => {
    assert.deepEqual(completionQuantities({ qty: 10 }), { producedQty: 10, scrappedQty: 0, unitsStarted: 10 });
    assert.deepEqual(completionQuantities({ qty: 10, scrappedQty: 2 }), { producedQty: 8, scrappedQty: 2, unitsStarted: 10 });
    assert.deepEqual(completionQuantities({ qty: 10, producedQty: 6 }), { producedQty: 6, scrappedQty: 0, unitsStarted: 6 }, "partial run");
    assert.deepEqual(completionQuantities({ qty: 10, producedQty: 5, scrappedQty: 1 }), { producedQty: 5, scrappedQty: 1, unitsStarted: 6 });
    assert.throws(() => completionQuantities({ qty: 10, producedQty: 9, scrappedQty: 2 }), is422, "can't exceed the order");
    assert.throws(() => completionQuantities({ qty: 10, producedQty: 0, scrappedQty: 0 }), is422, "at least one unit");
    assert.throws(() => completionQuantities({ qty: 10, producedQty: 1.5 }), is422);
  });

  it("consumes components for units produced AND scrapped", () => {
    const comps = componentsFromBom([
      { id: "a", partName: "Plate", qty: 2, unitCostUsd: 3, productId: "p-plate", trackInventory: true },
      { id: "b", partName: "Glue", qty: 0.5, unitCostUsd: 1, productId: null },
    ]);
    const lines = consumption(comps, 7);
    assert.deepEqual(lines.map((l) => [l.name, l.consumedQty, l.costCents]), [["Plate", 14, 4200], ["Glue", 4, 400]]);
  });
});

describe("costing", () => {
  it("labour = logged seconds × hourly rate, rounded half-up once", () => {
    assert.equal(labourCents(3600, 6000), 6000);
    assert.equal(labourCents(90, 4000), 100);
    assert.equal(labourCents(1, 1800), 1, "0.5c rounds half up");
    assert.equal(labourCents(0, 9999), 0);
  });

  it("splits components + labour between finished goods and scrap; parts add back to the total", () => {
    const c = moCosting([{ costCents: 4200 }, { costCents: 400 }], [{ actualSeconds: 1800, hourlyCostCents: 6000 }, { actualSeconds: 600, hourlyCostCents: 3000 }], 5, 2);
    assert.equal(c.componentCostCents, 4600);
    assert.equal(c.labourCostCents, 3000 + 500);
    const total = 8100;
    assert.equal(c.scrapCostCents, Math.floor((2 * total * 2 + 7) / 14)); // round(8100 × 2 / 7)
    assert.equal(c.finishedCostCents + c.scrapCostCents, total);
    assert.equal(c.unitCostCents, Math.round(c.finishedCostCents / 5));
    const none = moCosting([{ costCents: 100 }], [], 3, 0);
    assert.equal(none.scrapCostCents, 0);
    assert.equal(none.finishedCostCents, 100);
    const allScrap = moCosting([{ costCents: 100 }], [], 0, 2);
    assert.equal(allScrap.scrapCostCents, 100);
    assert.equal(allScrap.unitCostCents, 0);
  });

  it("the WIP and finish entries balance, and WIP nets to zero", () => {
    const c = { componentCostCents: 4600, labourCostCents: 3500, finishedCostCents: 5786, scrapCostCents: 2314 };
    const wip = moWipLines(c, "MO-0001");
    const fin = moFinishLines(c, "MO-0001");
    assert.equal(assertBalanced(wip), 8100);
    assert.equal(assertBalanced(fin), 8100);
    const wipNet = [...wip, ...fin]
      .filter((l) => "key" in l.account && l.account.key === "wip")
      .reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    assert.equal(wipNet, 0);
    // No labour, no scrap: the zero lines are compacted away.
    const plain = { componentCostCents: 500, labourCostCents: 0, finishedCostCents: 500, scrapCostCents: 0 };
    assert.equal(moWipLines(plain, "x").length, 2);
    assert.equal(moFinishLines(plain, "x").length, 2);
    assert.equal(assertBalanced(scrapLines(700, "finished_goods", "x")), 700);
  });
});

describe("work-order timer", () => {
  const t0 = new Date("2026-10-04T10:00:00Z");
  const at = (s: number) => new Date(t0.getTime() + s * 1000);
  it("start → pause logs a segment; resume → finish logs another; actual time adds up", () => {
    let s = timerStep({ status: "pending", runningSince: null, actualSeconds: 0 }, "in_progress", t0);
    assert.equal(s.segment, null);
    assert.deepEqual(s.runningSince, t0);
    s = timerStep({ status: s.status, runningSince: s.runningSince, actualSeconds: s.actualSeconds }, "paused", at(125));
    assert.equal(s.segment?.seconds, 125);
    assert.equal(s.actualSeconds, 125);
    s = timerStep({ status: s.status, runningSince: s.runningSince, actualSeconds: s.actualSeconds }, "in_progress", at(200));
    s = timerStep({ status: s.status, runningSince: s.runningSince, actualSeconds: s.actualSeconds }, "done", at(260));
    assert.equal(s.segment?.seconds, 60);
    assert.equal(s.actualSeconds, 185);
    assert.equal(s.runningSince, null);
  });
  it("illegal moves are 409; capacity caps concurrent work", () => {
    assert.throws(() => timerStep({ status: "pending", runningSince: null, actualSeconds: 0 }, "paused", t0), is409);
    assert.throws(() => timerStep({ status: "done", runningSince: null, actualSeconds: 5 }, "in_progress", t0), is409);
    assert.ok(hasCapacity(2, 1));
    assert.ok(!hasCapacity(2, 2));
    assert.ok(hasCapacity(0, 0), "capacity is at least one");
  });
});
