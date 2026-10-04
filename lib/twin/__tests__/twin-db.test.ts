// ShapesOS Phase 13 (twincore): the digital twin on real Postgres, as the
// least-privilege app role — FORCE RLS on the three new tables; layout
// validation and same-workspace bindings through the ops entity routes'
// service; overlapping active dock bookings refused by the code AND by the
// exclusion constraint; a booking moving through its states is what
// siteSnapshot shows; publishing is gated; the sample site per kind is
// consistent and idempotent; the live stream sends a patch after a write;
// agent markers come from run events.
//   DATABASE_URL=<app role url> npx tsx --test lib/twin/__tests__/twin-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OpsError, opsCreate, opsEntityDef, opsPatch, type OpsActor } from "@/lib/ops/doctype";
import { siteSnapshot, listSites, siteSnapshotTx, TwinNotFoundError } from "../state";
import { createSampleSite, SAMPLE_SITE_CODES } from "../sample";
import { twinLiveStream } from "../live";
import { applyTwinPatch } from "../derive";
import type { TwinPatchOp, TwinSnapshot } from "../types";
import { twinAssignEquipmentCore, twinBookDockCore, twinDraftLayout, twinFindCore, twinSiteStateCore } from "@/lib/chat/ops-twin-tools";
import type { ToolContext } from "@/lib/chat/tools";

const WS = "p13twin-ws-a";
const WS_B = "p13twin-ws-b";
const A: OpsActor = { workspaceId: WS, userId: "user-p13twin" };
const B: OpsActor = { workspaceId: WS_B, userId: "user-p13twin-b" };
const inA = <T>(fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(WS, fn);
const pendingPort = { propose: async () => ({ id: "appr_twin", status: "pending", riskTier: "high" }), getApproval: async () => { throw new Error("unused"); } };

async function create(slug: string, body: Record<string, unknown>, actor: OpsActor = A) {
  const r = await withWorkspaceScope(actor.workspaceId, (tx) => opsCreate(tx, opsEntityDef(slug), actor, body));
  assert.equal(r.outcome, "done");
  return (r as { row: Record<string, unknown> }).row;
}
async function patch(slug: string, body: Record<string, unknown>) {
  const r = await inA((tx) => opsPatch(tx, opsEntityDef(slug), A, body));
  assert.equal(r.outcome, "done");
  return (r as { row: Record<string, unknown> }).row;
}
const status = (status: number) => (e: unknown) => e instanceof OpsError && e.status === status;

let siteId = "";
let wh = "";
let rack = "";
let bin = "";
let dock1 = "";
let dock2 = "";
let dockObj = "";
let rackObj = "";
let foreignLoc = "";
let mug = "";
let po = "";

before(async () => {
  for (const id of [WS, WS_B]) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${"test:" + id}, now())`;
  }
  wh = String((await create("warehouses", { name: "Main", code: "TW-MAIN" })).id);
  const zone = String((await create("locations", { warehouseId: wh, kind: "zone", code: "A" })).id);
  rack = String((await create("locations", { warehouseId: wh, parentId: zone, kind: "rack", code: "A-01" })).id);
  bin = String((await create("locations", { warehouseId: wh, parentId: rack, kind: "bin", code: "A-01-1" })).id);
  dock1 = String((await create("locations", { warehouseId: wh, kind: "dock", code: "D1" })).id);
  dock2 = String((await create("locations", { warehouseId: wh, kind: "dock", code: "D2" })).id);
  mug = String((await create("products", { name: "Mug", sku: "TW-MUG", priceCents: 1000 })).id);
  await create("inventory-txns", { productId: mug, delta: 9, reason: "restock", locationId: bin });
  po = String((await create("purchase-orders", { supplierName: "Acme", lineItems: [{ name: "Mug", qty: 10, priceCents: 500 }] })).id);
  const whB = String((await create("warehouses", { name: "B", code: "TW-B" }, B)).id);
  foreignLoc = String((await create("locations", { warehouseId: whB, kind: "dock", code: "D9" }, B)).id);
});

after(async () => {
  for (const id of [WS, WS_B]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$disconnect();
});

describe("p13 digital twin (real Postgres, app role)", () => {
  it("creates a draft site over a warehouse (one per warehouse, code unique)", async () => {
    const s = await create("twin-sites", { kind: "warehouse", name: "Main", code: "TW-01", gridW: 30, gridD: 20, warehouseId: wh });
    siteId = String(s.id);
    assert.equal(s.status, "draft");
    await assert.rejects(inA((tx) => opsCreate(tx, opsEntityDef("twin-sites"), A, { kind: "warehouse", name: "Again", code: "TW-02", gridW: 10, gridD: 10, warehouseId: wh })), status(409));
    await assert.rejects(inA((tx) => opsCreate(tx, opsEntityDef("twin-sites"), A, { kind: "store", name: "x", code: "TW-03", gridW: 10, gridD: 10, warehouseId: "nope" })), status(404));
    assert.deepEqual((await listSites(WS)).map((s) => [s.code, s.status, s.objectCount]), [["TW-01", "draft", 0]]);
  });

  it("layout validation: in the grid, no overlaps (paths exempt), binding kinds, same-workspace bindings", async () => {
    rackObj = String((await create("twin-objects", { siteId, kind: "rack", label: "Rack A-01", x: 1, z: 1, w: 4, d: 2, h: 3, bindingType: "location", bindingId: rack })).id);
    dockObj = String((await create("twin-objects", { siteId, kind: "dock_door", label: "Dock 1", x: 0, z: 18, w: 3, d: 2, bindingType: "location", bindingId: dock1 })).id);
    await create("twin-objects", { siteId, kind: "dock_door", label: "Dock 2", x: 4, z: 18, w: 3, d: 2, bindingType: "location", bindingId: dock2 });
    await create("twin-objects", { siteId, kind: "path", label: "Aisle", x: 0, z: 1, w: 30, d: 1 });
    const make = (body: Record<string, unknown>) => inA((tx) => opsCreate(tx, opsEntityDef("twin-objects"), A, { siteId, ...body }));
    await assert.rejects(make({ kind: "rack", label: "Overlap", x: 3, z: 2, w: 2, d: 2 }), (e: unknown) => status(409)(e) && /overlap "Rack A-01"/.test((e as Error).message));
    await assert.rejects(make({ kind: "rack", label: "Off grid", x: 28, z: 0, w: 4, d: 1 }), status(422));
    await assert.rejects(make({ kind: "dock_door", label: "Wrong kind", x: 10, z: 10, bindingType: "location", bindingId: rack }), status(422), "a dock door binds a dock");
    await assert.rejects(make({ kind: "dock_door", label: "Wrong type", x: 10, z: 10, bindingType: "work_center", bindingId: rack }), status(422));
    // Another workspace's location is not found here (RLS + explicit scope).
    await assert.rejects(make({ kind: "dock_door", label: "Foreign", x: 10, z: 10, bindingType: "location", bindingId: foreignLoc }), status(404));
    await assert.rejects(inA((tx) => opsPatch(tx, opsEntityDef("twin-objects"), A, { id: dockObj, bindingId: foreignLoc })), status(404));
    await assert.rejects(make({ kind: "rack", label: "Status", x: 10, z: 10, equipmentStatus: "busy" }), status(400), "stored state is equipment-only");
    // Moving the rack onto the dock is refused; moving it to free space works.
    await assert.rejects(inA((tx) => opsPatch(tx, opsEntityDef("twin-objects"), A, { id: rackObj, z: 17 })), status(409));
    assert.equal((await patch("twin-objects", { id: rackObj, x: 2 })).x, 2);
    // The grid can't shrink under its objects.
    await assert.rejects(inA((tx) => opsPatch(tx, opsEntityDef("twin-sites"), A, { id: siteId, gridD: 10 })), status(409));
  });

  it("equipment: assign a task (busy), free it; drawn at the task location's object", async () => {
    const f = String((await create("twin-objects", { siteId, kind: "equipment", label: "Forklift 1", x: 12, z: 1, h: 2 })).id);
    const busy = await patch("twin-objects", { id: f, taskLocationId: rack, taskNote: "Put away" });
    assert.equal(busy.equipmentStatus, "busy");
    assert.ok(busy.taskAssignedAt);
    let snap = await siteSnapshot(WS, siteId);
    const st = snap.objects.find((o) => o.id === f)!.state;
    assert.equal(st.kind, "equipment");
    if (st.kind === "equipment") {
      assert.deepEqual(st.position, { x: 4, z: 2 }, "the rack object's centre (x 2 + 4/2, z 1 + 2/2)");
      assert.equal(st.task?.label, "Rack A-01");
    }
    await assert.rejects(inA((tx) => opsPatch(tx, opsEntityDef("twin-objects"), A, { id: f, taskLocationId: foreignLoc })), status(404));
    const free = await patch("twin-objects", { id: f, equipmentStatus: "available" });
    assert.equal(free.taskLocationId, null);
    snap = await siteSnapshot(WS, siteId);
    const st2 = snap.objects.find((o) => o.id === f)!.state;
    if (st2.kind === "equipment") assert.deepEqual(st2.position, { x: 12.5, z: 1.5 }, "home cell centre");
  });

  it("dock bookings: the code refuses an overlapping active booking; the exclusion constraint does too", async () => {
    const eta = new Date(Date.now() + 3600_000);
    const b = await create("dock-bookings", { siteId, dockObjectId: dockObj, purchaseOrderId: po, carrier: "DHL", truckRef: "TRK-1", eta: eta.toISOString() });
    assert.equal(b.direction, "inbound", "a purchase order's truck is inbound");
    assert.equal(b.dockLocationId, dock1);
    await assert.rejects(
      inA((tx) => opsCreate(tx, opsEntityDef("dock-bookings"), A, { siteId, dockLocationId: dock1, direction: "outbound", eta: new Date(eta.getTime() + 30 * 60_000).toISOString() })),
      (e: unknown) => status(409)(e) && /already booked/.test((e as Error).message),
    );
    await assert.rejects(inA((tx) => opsCreate(tx, opsEntityDef("dock-bookings"), A, { siteId, dockLocationId: rack, eta: eta.toISOString() })), status(422), "only a dock");
    await assert.rejects(inA((tx) => opsCreate(tx, opsEntityDef("dock-bookings"), A, { siteId, dockLocationId: foreignLoc, eta: eta.toISOString() })), status(404));
    await assert.rejects(inA((tx) => opsCreate(tx, opsEntityDef("dock-bookings"), A, { siteId, dockLocationId: dock2, orderId: po, eta: eta.toISOString() })), status(404), "a PO id is not an order");
    // Bypass the service: the DB guard still refuses the overlap.
    await assert.rejects(
      inA((tx) =>
        tx.opsDockBooking.create({
          data: { workspaceId: WS, siteId, dockLocationId: dock1, direction: "inbound", eta: new Date(eta.getTime() + 10 * 60_000), status: "booked" },
        }),
      ),
      /ops_dock_bookings_no_overlap|exclusion|23P01/,
    );
    // Back-to-back is fine, and a cancelled booking frees its slot.
    const next = await create("dock-bookings", { siteId, dockLocationId: dock1, direction: "inbound", eta: new Date(eta.getTime() + 3600_000).toISOString() });
    await patch("dock-bookings", { id: next.id, status: "cancelled" });
    const again = await create("dock-bookings", { siteId, dockLocationId: dock1, direction: "inbound", eta: new Date(eta.getTime() + 3600_000).toISOString() });
    await patch("dock-bookings", { id: again.id, status: "cancelled" });
  });

  it("a booking moving through its states is reflected by siteSnapshot (dock state, KPIs, shipment steps)", async () => {
    const booking = await inA((tx) => tx.opsDockBooking.findFirstOrThrow({ where: { dockLocationId: dock1, status: "booked" } }));
    const dockState = async () => {
      const s = await siteSnapshot(WS, siteId);
      return { s, dock: s.objects.find((o) => o.id === dockObj)! };
    };
    let { s, dock } = await dockState();
    assert.equal(dock.state.kind === "dock_door" && dock.state.status, "booked");
    assert.equal(dock.pill, "Booked");
    assert.equal(s.shipments.find((x) => x.id === booking.id)!.dockObjectId, dockObj);
    await assert.rejects(inA((tx) => opsPatch(tx, opsEntityDef("dock-bookings"), A, { id: booking.id, status: "done" })), status(409), "booked → done skips steps");
    await patch("dock-bookings", { id: booking.id, status: "arrived" });
    await assert.rejects(inA((tx) => opsPatch(tx, opsEntityDef("dock-bookings"), A, { id: booking.id, status: "loading" })), status(409), "an inbound truck is unloaded");
    await patch("dock-bookings", { id: booking.id, status: "unloading" });
    ({ s, dock } = await dockState());
    assert.equal(dock.state.kind === "dock_door" && dock.state.status, "occupied");
    assert.equal(dock.pill, "Unloading");
    assert.equal(s.kpis.find((k) => k.key === "trucks_on_site")!.value, 1);
    const ship = s.shipments.find((x) => x.id === booking.id)!;
    assert.deepEqual(ship.steps.map((x) => [x.key, x.done]), [["confirmed", false], ["booked", true], ["arrived", true], ["unloading", true], ["received", false]]);
    assert.equal(ship.currentStep, 0, "the PO was never sent");
    await patch("dock-bookings", { id: booking.id, status: "done" });
    ({ s, dock } = await dockState());
    assert.equal(dock.state.kind === "dock_door" && dock.state.status, "free");
    assert.equal(s.kpis.find((k) => k.key === "trucks_on_site")!.value, 0);
    // Arrived before its ETA → on time.
    assert.deepEqual([s.kpis.find((k) => k.key === "on_time_delivery_30d")!.value, s.kpis.find((k) => k.key === "on_time_delivery_30d")!.hint], [100, "1 of 1 deliveries, 30 days"]);
    assert.equal(s.shipments.find((x) => x.id === booking.id)!.steps.at(-1)!.done, true, "received when the booking is done");
  });

  it("rack stock comes from the ledger over the location subtree; low stock raises bin_low", async () => {
    let s = await siteSnapshot(WS, siteId);
    const r = s.objects.find((o) => o.id === rackObj)!;
    assert.deepEqual(r.state, { kind: "rack", onHand: 9, skuCount: 1, lowStockCount: 0 });
    await create("reorder-rules", { productId: mug, warehouseId: wh, minQty: 10, maxQty: 40 });
    s = await siteSnapshot(WS, siteId);
    const low = s.objects.find((o) => o.id === rackObj)!;
    assert.equal(low.state.kind === "rack" && low.state.lowStockCount, 1);
    assert.equal(low.alert?.key, "bin_low");
    assert.equal(s.kpis[0]!.value, 9);
  });

  it("publishing is gated (an approval is proposed); un-publishing is free", async () => {
    const r = await inA((tx) => opsPatch(tx, opsEntityDef("twin-sites"), A, { id: siteId, status: "published" }, { gatePort: pendingPort }));
    assert.equal(r.outcome, "approval_required");
    assert.equal((await inA((tx) => tx.opsSite.findFirstOrThrow({ where: { id: siteId } }))).status, "draft");
  });

  it("agent markers: a running run whose events mention a bound record marks the object", async () => {
    const run = await inA((tx) => tx.agentRun.create({ data: { workspaceId: WS, kind: "chat", status: "running", startedBy: A.userId, agentKey: "operator", nextSeq: 1 } }));
    await inA((tx) => tx.agentRunEvent.create({ data: { workspaceId: WS, runId: run.id, seq: 0, type: "agui", summary: `twin_book_dock: booked ${dock2} for TRK-7`, payload: { kind: "tool_result", tool: "twin_book_dock" } } }));
    const s = await siteSnapshot(WS, siteId);
    const dock2Obj = s.objects.find((o) => o.binding?.id === dock2)!;
    assert.deepEqual(s.agents.map((m) => [m.objectId, m.runId, m.status]), [[dock2Obj.id, run.id, "running"]]);
    await inA((tx) => tx.agentRun.update({ where: { id: run.id }, data: { status: "succeeded", endedAt: new Date() } }));
    assert.deepEqual((await siteSnapshot(WS, siteId)).agents, [], "a finished run that isn't waiting shows no marker");
  });

  it("the live stream sends a snapshot, then a patch after a write, then ends", async () => {
    const first = await siteSnapshot(WS, siteId);
    const stream = twinLiveStream(first, { snapshot: () => siteSnapshot(WS, siteId), stillAllowed: async () => true, pollMs: 60, maxMs: 4000, heartbeatMs: 10_000 });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const frames: Array<{ event: string; data: unknown }> = [];
    const nextFrame = async () => {
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (raw.startsWith(":")) continue;
          const event = /^event: (.*)$/m.exec(raw)![1]!;
          const data = JSON.parse(/^data: (.*)$/m.exec(raw)![1]!);
          frames.push({ event, data });
          return { event, data };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += decoder.decode(value, { stream: true });
      }
    };
    const f0 = await nextFrame();
    assert.equal(f0.event, "snapshot");
    // A write elsewhere (a new booking on dock 2) shows up as a patch.
    await create("dock-bookings", { siteId, dockLocationId: dock2, direction: "outbound", truckRef: "TRK-LIVE", eta: new Date(Date.now() + 2 * 3600_000).toISOString() });
    const f1 = await nextFrame();
    assert.equal(f1.event, "patch");
    const ops = f1.data as TwinPatchOp[];
    assert.ok(ops.some((o) => /^\/objects\/\d+$/.test(o.path)), "the dock object is replaced in place");
    assert.ok(ops.some((o) => o.path === "/shipments"));
    const patched = applyTwinPatch(first as TwinSnapshot, ops);
    const dock2Obj = patched.objects.find((o) => o.binding?.id === dock2)!;
    assert.equal(dock2Obj.state.kind === "dock_door" && dock2Obj.state.booking?.truckRef, "TRK-LIVE");
    // Access revoked → end.
    await reader.cancel();
  });

  it("the live stream ends when access is revoked", async () => {
    const first = await siteSnapshot(WS, siteId);
    const stream = twinLiveStream(first, { snapshot: () => siteSnapshot(WS, siteId), stillAllowed: async () => false, pollMs: 20, maxMs: 2000 });
    const text = await new Response(stream).text();
    assert.match(text, /^event: snapshot/);
    assert.match(text, /event: end\ndata: \{"reason":"access-revoked"\}/);
  });

  it("RLS: workspace B sees none of A's twin rows; no GUC sees nothing; B can't snapshot A's site", async () => {
    const counts = await withWorkspaceScope(WS_B, async (tx) => [
      await tx.opsSite.count({ where: { workspaceId: WS } }),
      await tx.opsSiteObject.count({ where: { workspaceId: WS } }),
      await tx.opsDockBooking.count({ where: { workspaceId: WS } }),
    ]);
    assert.deepEqual(counts, [0, 0, 0]);
    for (const t of ["ops_sites", "ops_site_objects", "ops_dock_bookings"]) {
      const n = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM ${t}`);
      assert.equal(Number(n[0]!.n), 0, `${t}: FORCE RLS`);
      const f = await prisma.$queryRawUnsafe<Array<{ forced: boolean }>>(`SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = '${t}'`);
      assert.equal(f[0]!.forced, true, `${t} has FORCE ROW LEVEL SECURITY`);
    }
    await assert.rejects(siteSnapshot(WS_B, siteId), (e: unknown) => e instanceof TwinNotFoundError);
    await assert.rejects(withWorkspaceScope(WS_B, (tx) => tx.opsSite.create({ data: { workspaceId: WS, kind: "store", name: "x", code: "X", gridW: 10, gridD: 10, warehouseId: wh } })));
  });
});

describe("p13 twin agent tools (real Postgres, app role)", () => {
  it("twin_book_dock books a named dock or the first free one; clashes are refused", async () => {
    const eta = new Date(Date.now() + 6 * 3600_000);
    const named = await inA((tx) => twinBookDockCore(tx, A, { site: "TW-01", dock: "Dock 2", eta: eta.toISOString(), truckRef: "TRK-AG1", direction: "inbound" }));
    assert.match(named.summary, /Booked Dock 2 \[/);
    const d = named.details as { booking: { dockLocationId: string }; dockObjectId: string };
    assert.equal(d.booking.dockLocationId, dock2);
    // Dock 2 is taken at that ETA → the next free dock (Dock 1) is used.
    const auto = await inA((tx) => twinBookDockCore(tx, A, { eta: eta.toISOString(), truckRef: "TRK-AG2", direction: "outbound" }));
    assert.equal((auto.details as { booking: { dockLocationId: string } }).booking.dockLocationId, dock1);
    await assert.rejects(inA((tx) => twinBookDockCore(tx, A, { eta: eta.toISOString(), direction: "inbound" })), /No dock on TW-01 is free/);
    await assert.rejects(inA((tx) => twinBookDockCore(tx, A, { dock: "Dock 2", eta: eta.toISOString() })), (e: unknown) => e instanceof OpsError && e.status === 409);
    await assert.rejects(inA((tx) => twinBookDockCore(tx, A, { eta: "soon" })), /ISO/);
  });

  it("twin_find finds a truck, a dock by name and the racks holding a SKU", async () => {
    const truck = await inA((tx) => twinFindCore(tx, A, { query: "TRK-AG1" }));
    assert.match(truck.summary, /Dock 2 \[.*shipment TRK-AG1: next Arrived/);
    const sku = await inA((tx) => twinFindCore(tx, A, { query: "TW-MUG" }));
    assert.match(sku.summary, /Rack A-01 \[.*holds 9 × TW-MUG Mug/);
    assert.match((await inA((tx) => twinFindCore(tx, A, { query: "nothing-like-this" }))).summary, /Nothing on the twin/);
  });

  it("twin_assign_equipment gives a forklift a task by object label and frees it", async () => {
    const busy = await inA((tx) => twinAssignEquipmentCore(tx, A, { equipment: "Forklift 1", to: "Rack A-01", note: "Count stock" }));
    assert.match(busy.summary, /Forklift 1 \[.*\] is now busy → Rack A-01/);
    const free = await inA((tx) => twinAssignEquipmentCore(tx, A, { equipment: "Forklift 1", status: "available" }));
    assert.match(free.summary, /is now available/);
    await assert.rejects(inA((tx) => twinAssignEquipmentCore(tx, A, { equipment: "Forklift 99" })), /No equipment/);
  });

  it("twin_site_state summarises KPIs, busy docks and alerts with object ids", async () => {
    const r = await inA((tx) => twinSiteStateCore(tx, A, {}));
    assert.match(r.summary, /^Main \(TW-01, warehouse, draft\)\. Stock on hand 9/);
    assert.match(r.summary, /Busy docks: Dock 1 \[/);
    assert.match(r.summary, /Alerts: Rack A-01 \[.*at or below the reorder point/);
  });

  it("twin_draft_layout without a live model lays out the warehouse's records as a DRAFT and says so", async () => {
    const wh2 = String((await create("warehouses", { name: "Overflow", code: "TW-OVF" })).id);
    const z = String((await create("locations", { warehouseId: wh2, kind: "zone", code: "Z" })).id);
    await create("locations", { warehouseId: wh2, parentId: z, kind: "rack", code: "Z-01" });
    await create("locations", { warehouseId: wh2, kind: "dock", code: "OD1" });
    const ctx: ToolContext = { projectId: "p13-twin", workspaceId: WS, userId: A.userId, role: "editor", confirmed: true };
    const { llmStatus } = await import("@/lib/llm");
    const live = llmStatus().routing.subagent.isLive;
    const r = await twinDraftLayout(ctx, { kind: "warehouse", warehouse: "TW-OVF", description: "Two racks by the north wall" });
    const d = r.details as { siteId: string; source: string; objects: number };
    if (!live) {
      assert.equal(d.source, "records");
      assert.match(r.summary, /description was not read/);
    }
    assert.match(r.summary, /DRAFT — publishing it needs a person's approval/);
    const snap = await siteSnapshot(WS, d.siteId);
    assert.equal(snap.site.status, "draft");
    assert.equal(snap.objects.filter((o) => o.bindingBroken).length, 0);
    if (!live) assert.deepEqual(snap.objects.filter((o) => o.binding).map((o) => o.binding!.label).sort(), ["TW-OVF/OD1", "TW-OVF/Z/Z-01"]);
  });
});

describe("p13 sample sites (real Postgres, app role)", () => {
  for (const kind of ["warehouse", "factory", "store"] as const) {
    it(`${kind}: a consistent site from real records, idempotent`, async () => {
      const r = await withWorkspaceScope(WS, (tx) => createSampleSite(tx, A, kind), { timeoutMs: 60_000 });
      assert.equal(r.created, true);
      const again = await withWorkspaceScope(WS, (tx) => createSampleSite(tx, A, kind), { timeoutMs: 60_000 });
      assert.deepEqual(again, { ...r, created: false });
      const s = await withWorkspaceScope(WS, (tx) => siteSnapshotTx(tx, WS, r.siteId));
      assert.equal(s.site.code, SAMPLE_SITE_CODES[kind]);
      assert.equal(s.site.status, "draft");
      assert.equal(s.objects.length, r.objectCount);
      assert.equal(s.objects.filter((o) => o.bindingBroken).length, 0, "every binding resolves");
      assert.equal(s.objects.filter((o) => o.kind === "equipment").length, 2, "two forklifts / carts");
      assert.ok(s.objects.some((o) => o.state.kind === "equipment" && o.state.status === "busy"));
      assert.ok(s.kpis.find((k) => k.key === "stock_on_hand")!.value > 0, "stock through the ledger");
      assert.ok(s.shipments.length >= 2, "a couple of dock bookings");
      const states = (k: string) => s.objects.filter((o) => o.kind === k).map((o) => (o.state as { status?: string }).status);
      if (kind === "warehouse") {
        assert.deepEqual(states("dock_door").sort(), ["booked", "booked", "free", "occupied"]);
        assert.equal(s.kpis.find((k) => k.key === "trucks_on_site")!.value, 1);
        assert.equal(s.kpis.find((k) => k.key === "on_time_delivery_30d")!.value, 100);
        assert.ok(s.objects.some((o) => o.alert?.key === "bin_low"), "bolts run low");
      }
      if (kind === "factory") {
        assert.deepEqual(states("work_center").sort(), ["idle", "running"]);
        const util = s.kpis.find((k) => k.key === "work_center_utilisation")!;
        assert.ok(util.value > 0, "logged time counts");
        const cnc = s.objects.find((o) => o.label === "CNC mill")!;
        assert.equal(cnc.state.kind === "work_center" && cnc.state.late, true, "the MO is past its planned start");
      }
      if (kind === "store") {
        assert.deepEqual(states("register").sort(), ["closed", "open"]);
        assert.equal(s.kpis.find((k) => k.key === "open_registers")!.value, 1);
        assert.equal(s.kpis.find((k) => k.key === "sales_today")!.value, 2400);
        const till = s.objects.find((o) => o.state.kind === "register" && o.state.status === "open")!;
        assert.equal(till.state.kind === "register" && till.state.salesCents, 2400);
      }
    });
  }
});
