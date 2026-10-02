// Marketr — CAD + Hardware slice 4 tests: hardware project management.
// Parts inventory (auditable stock events, never silent overwrites,
// negative-stock guard with explicit confirmation, low-stock flags),
// supplier tracking (part↔supplier links, quoted costs with source+date,
// preferred marking), revision-linked tasks/issues (pinned to immutable
// CadModelVersion rows, untouched by task closure), and the project
// dashboard rollup (grounded counts from real rows).
// Run: npx tsx --test lib/cad/__tests__/cad-slice4.test.ts
//
// DB-backed tests run against the local dev DB and clean up their own test
// workspaces (cascades purge CAD rows). Pure-domain tests use real
// fixtures, not mocks.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaCadProjectStore } from "../project-store";
import {
  computeStockAdjustment,
  isLowStock,
  isTaskOpen,
  preferredQuoteCostUsd,
  quoteCitation,
  validatePartInput,
  validatePartSupplierLinkInput,
  validateTaskCommentBody,
  validateTaskInput,
} from "../hardware";
import { CadError } from "../types";

const store = new PrismaCadProjectStore(prisma);
const testWorkspaceIds: string[] = [];
const ACTOR = "tico@test";

async function makeWorkspace(): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-cad-slice4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-cad-slice4",
    },
  });
  testWorkspaceIds.push(ws.id);
  return ws.id;
}

after(async () => {
  for (const id of testWorkspaceIds) {
    await prisma.workspace.deleteMany({ where: { id } }).catch(() => {});
  }
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof CadError, `expected CadError, got ${e}`);
    return e.code;
  }
  throw new Error("expected a CadError but the call succeeded");
}

// ---------- Fixtures ----------

interface RevisionFixture {
  projectId: string;
  modelId: string;
  v7: { id: string; versionNumber: number };
  v8: { id: string; versionNumber: number };
}

/** Project + model + two immutable versions (v7, v8), created directly
 *  through prisma — the pin tests need version ROWS, not the file pipeline. */
async function makeRevisionFixture(wsId: string, tag: string): Promise<RevisionFixture> {
  const project = await prisma.cadProject.create({
    data: { workspaceId: wsId, name: `hw-proj-${tag}`, createdBy: ACTOR },
  });
  const model = await prisma.cadModel.create({
    data: { workspaceId: wsId, projectId: project.id, name: "Airframe", createdBy: ACTOR },
  });
  const versions: { id: string; versionNumber: number }[] = [];
  for (const n of [7, 8]) {
    const file = await prisma.workspaceFile.create({
      data: {
        workspaceId: wsId,
        logicalPath: `/files/cad-test/${tag}/v${n}.stl`,
        storageKey: `cad-test-${tag}-${n}-${Math.random().toString(36).slice(2, 8)}`,
        filename: `v${n}.stl`,
        mimeType: "model/stl",
        sizeBytes: 84,
        kind: "file",
        createdBy: ACTOR,
      },
    });
    const v = await prisma.cadModelVersion.create({
      data: {
        workspaceId: wsId,
        modelId: model.id,
        versionNumber: n,
        workspaceFileId: file.id,
        fileName: `v${n}.stl`,
        sizeBytes: 84,
        checksum: `sum-${tag}-${n}`,
        format: "stl",
        previewAvailable: true,
        uploadedBy: ACTOR,
      },
    });
    versions.push({ id: v.id, versionNumber: v.versionNumber });
  }
  await prisma.cadModel.update({
    where: { id: model.id },
    data: { currentVersionId: versions[1]!.id },
  });
  return {
    projectId: project.id,
    modelId: model.id,
    v7: versions[0]!,
    v8: versions[1]!,
  };
}

// ============================================================
// A. Pure domain: hardware.ts
// ============================================================

describe("hardware domain (pure)", () => {
  it("computeStockAdjustment: +delta raises on-hand", () => {
    const c = computeStockAdjustment(10, { delta: 5, reason: "received PO-114" });
    assert.equal(c.quantityAfter, 15);
    assert.equal(c.delta, 5);
  });

  it("computeStockAdjustment: -delta lowers on-hand", () => {
    const c = computeStockAdjustment(10, { delta: -4, reason: "used in airframe v7 build" });
    assert.equal(c.quantityAfter, 6);
  });

  it("computeStockAdjustment: zero delta is rejected", () => {
    assert.throws(
      () => computeStockAdjustment(10, { delta: 0, reason: "noop" }),
      (e: unknown) => e instanceof CadError && e.code === "INVALID_ADJUSTMENT",
    );
  });

  it("computeStockAdjustment: a reason is required (audit trail)", () => {
    assert.throws(
      () => computeStockAdjustment(10, { delta: 1, reason: "  " }),
      (e: unknown) => e instanceof CadError && e.code === "INVALID_ADJUSTMENT",
    );
  });

  it("computeStockAdjustment: below-zero fails closed without explicit confirmation", () => {
    assert.throws(
      () => computeStockAdjustment(3, { delta: -5, reason: "shipped" }),
      (e: unknown) => e instanceof CadError && e.code === "NEGATIVE_STOCK_CONFIRMATION_REQUIRED",
    );
  });

  it("computeStockAdjustment: explicit confirmBelowZero permits negative stock", () => {
    const c = computeStockAdjustment(3, { delta: -5, reason: "shipped early", confirmBelowZero: true });
    assert.equal(c.quantityAfter, -2);
  });

  it("isLowStock: on-hand AT the reorder point is low (honest boundary)", () => {
    assert.ok(isLowStock(10, 10));
    assert.ok(isLowStock(2, 10));
    assert.ok(!isLowStock(11, 10));
  });

  it("isTaskOpen: open/in_progress/blocked are open; done is not", () => {
    assert.ok(isTaskOpen("open"));
    assert.ok(isTaskOpen("in_progress"));
    assert.ok(isTaskOpen("blocked"));
    assert.ok(!isTaskOpen("done"));
  });

  it("validatePartInput: sane defaults, rejects bad category and negative reorder", () => {
    const v = validatePartInput({ name: "  M3 screw  " });
    assert.equal(v.name, "M3 screw");
    assert.equal(v.category, "other");
    assert.equal(v.unitOfMeasure, "pcs");
    assert.equal(v.onHandQty, 0);
    assert.throws(
      () => validatePartInput({ name: "x", category: "rocket" }),
      (e: unknown) => e instanceof CadError && e.code === "INVALID_PART",
    );
    assert.throws(
      () => validatePartInput({ name: "x", reorderPoint: -1 }),
      (e: unknown) => e instanceof CadError && e.code === "INVALID_PART",
    );
    assert.throws(
      () => validatePartInput({ name: "  " }),
      (e: unknown) => e instanceof CadError && e.code === "INVALID_PART",
    );
  });

  it("validatePartSupplierLinkInput: a quoted cost requires its source", async () => {
    await assert.rejects(
      (async () => {
        const bad = validatePartSupplierLinkInput({ quotedUnitCost: 12.5, currency: "USD" });
        return bad;
      })(),
      (e: unknown) => e instanceof CadError && e.code === "INVALID_QUOTE",
    );
    const good = validatePartSupplierLinkInput({
      quotedUnitCost: 12.5,
      currency: "USD",
      quotedDate: "2026-09-30",
      quoteSource: "Acme quote PDF Q-4471",
    });
    assert.equal(good.quotedUnitCost, 12.5);
    assert.equal(good.currency, "USD");
    assert.equal(good.quotedDate?.toISOString().slice(0, 10), "2026-09-30");
    assert.throws(
      () => validatePartSupplierLinkInput({ quotedUnitCost: 1, currency: "US", quoteSource: "s" }),
      (e: unknown) => e instanceof CadError && e.code === "INVALID_QUOTE",
    );
  });

  it("preferredQuoteCostUsd: USD+preferred only — never an invented FX conversion", () => {
    const base = { quotedUnitCost: 10, currency: "USD" };
    assert.deepEqual(preferredQuoteCostUsd({ ...base, preferred: true }), { costUsd: 10, currency: "USD" });
    assert.equal(preferredQuoteCostUsd({ ...base, preferred: false }), null);
    assert.equal(preferredQuoteCostUsd({ preferred: true, quotedUnitCost: null, currency: "USD" }), null);
    assert.equal(preferredQuoteCostUsd({ preferred: true, quotedUnitCost: 9, currency: "EUR" }), null);
  });

  it("quoteCitation: cites supplier, date, and source", () => {
    const c = quoteCitation({
      supplierName: "Acme",
      quotedUnitCost: 12.5,
      currency: "USD",
      quotedDate: new Date("2026-09-30T00:00:00.000Z"),
      quoteSource: "quote PDF Q-4471",
    });
    assert.ok(c.includes("Acme"));
    assert.ok(c.includes("2026-09-30"));
    assert.ok(c.includes("Q-4471"));
  });

  it("validateTaskInput: defaults and rejections", () => {
    const v = validateTaskInput({ title: " Tighten mount " });
    assert.equal(v.title, "Tighten mount");
    assert.equal(v.kind, "task");
    assert.equal(v.status, "open");
    assert.equal(v.priority, "medium");
    assert.equal(v.modelVersionId, null);
    assert.throws(
      () => validateTaskInput({ title: "x", status: "archived" }),
      (e: unknown) => e instanceof CadError && e.code === "INVALID_TASK",
    );
    assert.throws(
      () => validateTaskInput({ title: "" }),
      (e: unknown) => e instanceof CadError && e.code === "INVALID_TASK",
    );
  });

  it("validateTaskCommentBody: empty and overlong bodies rejected", () => {
    assert.throws(
      () => validateTaskCommentBody("   "),
      (e: unknown) => e instanceof CadError && e.code === "INVALID_COMMENT",
    );
    assert.throws(
      () => validateTaskCommentBody("x".repeat(8001)),
      (e: unknown) => e instanceof CadError && e.code === "INVALID_COMMENT",
    );
    assert.equal(validateTaskCommentBody("  noted  "), "noted");
  });
});

// ============================================================
// B. Parts inventory: event-sourced stock, never silent overwrites
// ============================================================

describe("parts inventory", () => {
  it("createPart records the opening balance as an auditable stock event", async () => {
    const ws = await makeWorkspace();
    const part = await store.createPart(ws, ACTOR, {
      name: "Carbon arm",
      sku: "CA-220",
      category: "mechanical",
      onHandQty: 24,
      reorderPoint: 10,
      unitOfMeasure: "pcs",
      storageLocation: "bin A-3",
    });
    assert.equal(part.name, "Carbon arm");
    assert.equal(part.onHandQty, 24);
    const events = await store.listStockEvents(ws, part.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.delta, 24);
    assert.equal(events[0]!.quantityAfter, 24);
    assert.equal(events[0]!.reason, "opening balance");
    assert.equal(events[0]!.actor, ACTOR);
  });

  it("adjustStock appends exactly one event per adjustment — never a silent overwrite", async () => {
    const ws = await makeWorkspace();
    const part = await store.createPart(ws, ACTOR, { name: "M3 screw", onHandQty: 100 });
    await store.adjustStock(ws, ACTOR, part.id, { delta: -30, reason: "used in airframe v7 build" });
    await store.adjustStock(ws, ACTOR, part.id, { delta: 50, reason: "received PO-114" });
    const events = await store.listStockEvents(ws, part.id);
    assert.equal(events.length, 3); // opening + 2 adjustments
    const newest = events[0]!;
    assert.equal(newest.delta, 50);
    assert.equal(newest.quantityAfter, 120);
    assert.equal(newest.reason, "received PO-114");
    const refetched = await prisma.cadPart.findUnique({ where: { id: part.id } });
    assert.equal(refetched!.onHandQty, 120);
  });

  it("adjustStock below zero fails closed and writes NO event without explicit confirmation", async () => {
    const ws = await makeWorkspace();
    const part = await store.createPart(ws, ACTOR, { name: "Propeller 7in", onHandQty: 3 });
    const code = await codeOf(
      store.adjustStock(ws, ACTOR, part.id, { delta: -5, reason: "shipped" }),
    );
    assert.equal(code, "NEGATIVE_STOCK_CONFIRMATION_REQUIRED");
    const events = await store.listStockEvents(ws, part.id);
    assert.equal(events.length, 1); // only the opening balance — the failed attempt wrote nothing
    const refetched = await prisma.cadPart.findUnique({ where: { id: part.id } });
    assert.equal(refetched!.onHandQty, 3);
  });

  it("adjustStock with explicit confirmBelowZero writes the event and goes negative", async () => {
    const ws = await makeWorkspace();
    const part = await store.createPart(ws, ACTOR, { name: "Propeller 7in", onHandQty: 3 });
    const updated = await store.adjustStock(ws, ACTOR, part.id, {
      delta: -5,
      reason: "shipped early — backorder expected",
      confirmBelowZero: true,
    });
    assert.equal(updated.onHandQty, -2);
    const events = await store.listStockEvents(ws, part.id);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.quantityAfter, -2);
  });

  it("adjustStock requires a reason and a non-empty actor", async () => {
    const ws = await makeWorkspace();
    const part = await store.createPart(ws, ACTOR, { name: "ESC 40A", onHandQty: 5 });
    assert.equal(
      await codeOf(store.adjustStock(ws, ACTOR, part.id, { delta: 1, reason: "" })),
      "INVALID_ADJUSTMENT",
    );
    assert.equal(
      await codeOf(store.adjustStock(ws, "   ", part.id, { delta: 1, reason: "ok" })),
      "INVALID_ACTOR",
    );
  });

  it("updatePart hard-rejects direct onHandQty edits; metadata edits still work", async () => {
    const ws = await makeWorkspace();
    const part = await store.createPart(ws, ACTOR, { name: "M3 screw", onHandQty: 10 });
    assert.equal(
      await codeOf(store.updatePart(ws, part.id, { onHandQty: 999 })),
      "STOCK_NOT_EDITABLE",
    );
    const updated = await store.updatePart(ws, part.id, { reorderPoint: 25, storageLocation: "bin B-1" });
    assert.equal(updated.reorderPoint, 25);
    assert.equal(updated.storageLocation, "bin B-1");
    assert.equal(updated.onHandQty, 10); // untouched
  });

  it("listParts lowStockOnly filters on honest arithmetic", async () => {
    const ws = await makeWorkspace();
    await store.createPart(ws, ACTOR, { name: "Low A", onHandQty: 2, reorderPoint: 10 });
    await store.createPart(ws, ACTOR, { name: "High B", onHandQty: 100, reorderPoint: 10 });
    await store.createPart(ws, ACTOR, { name: "Boundary C", onHandQty: 10, reorderPoint: 10 });
    const low = await store.listParts(ws, { lowStockOnly: true });
    const names = low.map((p) => p.name).sort();
    assert.deepEqual(names, ["Boundary C", "Low A"]);
    assert.ok(low.every((p) => p.lowStock));
    const all = await store.listParts(ws);
    assert.equal(all.length, 3);
  });
});

// ============================================================
// C. Suppliers: quoted-cost sourcing, preferred marking
// ============================================================

describe("suppliers + quoted costs", () => {
  it("linking a supplier with a quote requires source+date; preferred demotes the previous", async () => {
    const ws = await makeWorkspace();
    const part = await store.createPart(ws, ACTOR, { name: "Carbon arm" });
    const a = await store.createSupplier(ws, ACTOR, { name: "Acme Composites", leadTime: "2–3 weeks" });
    const b = await store.createSupplier(ws, ACTOR, { name: "Beta Fibers" });

    assert.equal(
      await codeOf(
        store.linkPartSupplier(ws, ACTOR, part.id, a.id, {
          quotedUnitCost: 12.5,
          currency: "USD",
          quotedDate: "2026-09-30",
          // no quoteSource
        }),
      ),
      "INVALID_QUOTE",
    );

    await store.linkPartSupplier(ws, ACTOR, part.id, a.id, {
      quotedUnitCost: 12.5,
      currency: "USD",
      quotedDate: "2026-09-30",
      quoteSource: "Acme quote PDF Q-4471",
      preferred: true,
    });
    await store.linkPartSupplier(ws, ACTOR, part.id, b.id, {
      quotedUnitCost: 11.0,
      currency: "USD",
      quotedDate: "2026-10-01",
      quoteSource: "Beta email thread",
      preferred: true,
    });
    const links = await store.listPartSuppliers(ws, part.id);
    assert.equal(links.length, 2);
    const preferred = links.filter((l) => l.preferred);
    assert.equal(preferred.length, 1);
    assert.equal(preferred[0]!.supplier.name, "Beta Fibers");
  });

  it("getPreferredQuoteCost cites the quote; non-USD preferred quotes stay out of costing", async () => {
    const ws = await makeWorkspace();
    const part = await store.createPart(ws, ACTOR, { name: "Motor 2207" });
    const s = await store.createSupplier(ws, ACTOR, { name: "Acme" });
    await store.linkPartSupplier(ws, ACTOR, part.id, s.id, {
      quotedUnitCost: 12.5,
      currency: "USD",
      quotedDate: "2026-09-30",
      quoteSource: "Acme quote PDF Q-4471",
      preferred: true,
    });
    const quote = await store.getPreferredQuoteCost(ws, part.id);
    assert.ok(quote);
    assert.equal(quote.costUsd, 12.5);
    assert.ok(quote.citation.includes("Acme"));
    assert.ok(quote.citation.includes("2026-09-30"));
    assert.ok(quote.citation.includes("Q-4471"));

    const eur = await store.createPart(ws, ACTOR, { name: "Gimbal" });
    const es = await store.createSupplier(ws, ACTOR, { name: "EuroParts" });
    await store.linkPartSupplier(ws, ACTOR, eur.id, es.id, {
      quotedUnitCost: 9,
      currency: "EUR",
      quotedDate: "2026-09-29",
      quoteSource: "EuroParts price list",
      preferred: true,
    });
    // No FX rate is invented: the EUR quote stays cited on the link only.
    assert.equal(await store.getPreferredQuoteCost(ws, eur.id), null);
    const links = await store.listPartSuppliers(ws, eur.id);
    assert.equal(links[0]!.currency, "EUR");
    assert.equal(links[0]!.quotedUnitCost, 9);
  });

  it("deleting a supplier with linked parts fails closed; unlinking first works", async () => {
    const ws = await makeWorkspace();
    const part = await store.createPart(ws, ACTOR, { name: "M3 screw" });
    const s = await store.createSupplier(ws, ACTOR, { name: "Acme" });
    const link = await store.linkPartSupplier(ws, ACTOR, part.id, s.id, { preferred: false });
    assert.equal(
      await codeOf(store.deleteSupplier(ws, s.id)),
      "SUPPLIER_HAS_PARTS",
    );
    await store.deletePartSupplierLink(ws, link.id);
    await store.deleteSupplier(ws, s.id);
    const suppliers = await store.listSuppliers(ws);
    assert.equal(suppliers.length, 0);
  });

  it("addBomLineWithInventoryPart uses the preferred USD quote; EUR quote leaves cost null", async () => {
    const ws = await makeWorkspace();
    const fix = await makeRevisionFixture(ws, "bomq");
    const bom = await store.createBomVersion(ws, ACTOR, fix.modelId, fix.v8.id, "notes");

    const part = await store.createPart(ws, ACTOR, { name: "Carbon arm" });
    const s = await store.createSupplier(ws, ACTOR, { name: "Acme" });
    await store.linkPartSupplier(ws, ACTOR, part.id, s.id, {
      quotedUnitCost: 12.5,
      currency: "USD",
      quotedDate: "2026-09-30",
      quoteSource: "Acme quote PDF Q-4471",
      preferred: true,
    });
    const { line, quote } = await store.addBomLineWithInventoryPart(ws, ACTOR, bom.id, {
      partName: "Carbon arm",
      qty: 4,
      inventoryPartId: part.id,
    });
    assert.equal(line.unitCostUsd, 12.5);
    assert.equal(line.supplier, "Acme"); // labeled from the quote
    assert.ok(quote && quote.costUsd === 12.5);

    const eurPart = await store.createPart(ws, ACTOR, { name: "Gimbal" });
    const es = await store.createSupplier(ws, ACTOR, { name: "EuroParts" });
    await store.linkPartSupplier(ws, ACTOR, eurPart.id, es.id, {
      quotedUnitCost: 9,
      currency: "EUR",
      quotedDate: "2026-09-29",
      quoteSource: "EuroParts price list",
      preferred: true,
    });
    const res2 = await store.addBomLineWithInventoryPart(ws, ACTOR, bom.id, {
      partName: "Gimbal",
      qty: 1,
      inventoryPartId: eurPart.id,
    });
    assert.equal(res2.line.unitCostUsd, null);
    assert.equal(res2.quote, null);
  });
});

// ============================================================
// D. Tasks/issues: revision pins, immutability, activity trail
// ============================================================

describe("tasks/issues", () => {
  it("a task pinned to v7 stays on v7 (the pin is a reference to the immutable revision)", async () => {
    const ws = await makeWorkspace();
    const fix = await makeRevisionFixture(ws, "pin7");
    const task = await store.createTask(ws, ACTOR, fix.projectId, {
      title: "Check wall thickness",
      kind: "issue",
      priority: "high",
      modelVersionId: fix.v7.id,
    });
    assert.equal(task.modelVersionId, fix.v7.id);
    const detail = await store.getTask(ws, task.id);
    assert.equal(detail.pinnedVersion?.versionNumber, 7);
    // …even after the model moves on to v8
    assert.equal(detail.pinnedVersion?.id, fix.v7.id);
    assert.notEqual(detail.pinnedVersion?.id, fix.v8.id);
  });

  it("closing a task never mutates the pinned version row (immutability held)", async () => {
    const ws = await makeWorkspace();
    const fix = await makeRevisionFixture(ws, "close");
    const task = await store.createTask(ws, ACTOR, fix.projectId, {
      title: "Thicken wall",
      modelVersionId: fix.v7.id,
    });
    const before = await prisma.cadModelVersion.findUnique({ where: { id: fix.v7.id } });
    assert.ok(before);
    const updated = await store.updateTask(ws, ACTOR, task.id, { status: "done" });
    assert.equal(updated.status, "done");
    assert.ok(updated.closedAt);
    assert.equal(updated.closedBy, ACTOR);
    const afterRow = await prisma.cadModelVersion.findUnique({ where: { id: fix.v7.id } });
    assert.deepEqual(
      { ...afterRow, createdAt: undefined, updatedAt: undefined, uploadedAt: undefined },
      { ...before, createdAt: undefined, updatedAt: undefined, uploadedAt: undefined },
      "the version row must be byte-identical after task closure",
    );
    // The activity trail recorded the status change.
    const detail = await store.getTask(ws, task.id);
    const kinds = detail.comments.map((c) => c.eventKind).sort();
    assert.deepEqual(kinds, ["created", "status_change"]);
  });

  it("reopening a done task clears closedAt/closedBy", async () => {
    const ws = await makeWorkspace();
    const fix = await makeRevisionFixture(ws, "reopen");
    const task = await store.createTask(ws, ACTOR, fix.projectId, { title: "Re-check" });
    await store.updateTask(ws, ACTOR, task.id, { status: "done" });
    const reopened = await store.updateTask(ws, ACTOR, task.id, { status: "in_progress" });
    assert.equal(reopened.closedAt, null);
    assert.equal(reopened.closedBy, null);
  });

  it("pinning to a version from another project is rejected", async () => {
    const ws = await makeWorkspace();
    const fixA = await makeRevisionFixture(ws, "pina");
    const fixB = await makeRevisionFixture(ws, "pinb");
    const task = await store.createTask(ws, ACTOR, fixA.projectId, { title: "Cross-project pin" });
    assert.equal(
      await codeOf(store.pinTaskVersion(ws, ACTOR, task.id, fixB.v7.id)),
      "VERSION_PROJECT_MISMATCH",
    );
    // …but pinning to a sibling revision in the same project works.
    const pinned = await store.pinTaskVersion(ws, ACTOR, task.id, fixA.v8.id);
    assert.equal(pinned.modelVersionId, fixA.v8.id);
    const detail = await store.getTask(ws, task.id);
    assert.ok(detail.comments.some((c) => c.eventKind === "version_pin"));
  });

  it("deleting a version keeps the task — the pin nulls and the work survives", async () => {
    const ws = await makeWorkspace();
    const fix = await makeRevisionFixture(ws, "delver");
    const task = await store.createTask(ws, ACTOR, fix.projectId, {
      title: "Survivor",
      modelVersionId: fix.v7.id,
    });
    await prisma.cadModelVersion.delete({ where: { id: fix.v7.id } });
    const detail = await store.getTask(ws, task.id);
    assert.equal(detail.pinnedVersion, null);
    assert.equal(detail.task.modelVersionId, null);
    assert.equal(detail.task.title, "Survivor");
  });

  it("comments append to the trail; updating a task requires an actor", async () => {
    const ws = await makeWorkspace();
    const fix = await makeRevisionFixture(ws, "comments");
    const task = await store.createTask(ws, ACTOR, fix.projectId, { title: "Discuss" });
    const c = await store.addTaskComment(ws, "dana@test", task.id, "Looks good to me.");
    assert.equal(c.author, "dana@test");
    assert.equal(c.eventKind, "comment");
    assert.equal(
      await codeOf(store.addTaskComment(ws, ACTOR, task.id, "   ")),
      "INVALID_COMMENT",
    );
    assert.equal(
      await codeOf(store.updateTask(ws, "  ", task.id, { priority: "high" })),
      "INVALID_ACTOR",
    );
    assert.equal(
      await codeOf(store.createTask(ws, "  ", fix.projectId, { title: "No actor" })),
      "INVALID_ACTOR",
    );
  });

  it("deleteTask removes the task and its trail", async () => {
    const ws = await makeWorkspace();
    const fix = await makeRevisionFixture(ws, "deltask");
    const task = await store.createTask(ws, ACTOR, fix.projectId, { title: "Temp" });
    await store.addTaskComment(ws, ACTOR, task.id, "bye");
    await store.deleteTask(ws, task.id);
    assert.equal(await codeOf(store.getTask(ws, task.id)), "TASK_NOT_FOUND");
  });
});

// ============================================================
// E. Project dashboard rollup: grounded in real rows
// ============================================================

describe("project dashboard", () => {
  it("counts come from real rows: open tasks/issues, blocked, done", async () => {
    const ws = await makeWorkspace();
    const fix = await makeRevisionFixture(ws, "dash");
    await store.createTask(ws, ACTOR, fix.projectId, { title: "T1", kind: "task" });
    await store.createTask(ws, ACTOR, fix.projectId, { title: "T2", kind: "task", status: "in_progress" });
    await store.createTask(ws, ACTOR, fix.projectId, { title: "I1", kind: "issue", status: "blocked" });
    await store.createTask(ws, ACTOR, fix.projectId, { title: "D1", kind: "task", status: "done" });
    const d = await store.getProjectDashboard(ws, fix.projectId);
    assert.equal(d.counts.openTasks, 2);
    assert.equal(d.counts.openIssues, 1);
    assert.equal(d.counts.blocked, 1);
    assert.equal(d.counts.done, 1);
    assert.equal(d.counts.total, 4);
    assert.equal(d.counts.models, 1);
  });

  it("low-stock parts are project-relevant: only BOM-linked parts appear", async () => {
    const ws = await makeWorkspace();
    const fix = await makeRevisionFixture(ws, "dashlow");
    const bom = await store.createBomVersion(ws, ACTOR, fix.modelId, fix.v8.id, "notes");

    const linkedLow = await store.createPart(ws, ACTOR, { name: "Linked low", onHandQty: 2, reorderPoint: 10 });
    await store.addBomLineWithInventoryPart(ws, ACTOR, bom.id, {
      partName: "Linked low",
      qty: 1,
      unitCostUsd: 1,
      inventoryPartId: linkedLow.id,
    });
    const linkedHigh = await store.createPart(ws, ACTOR, { name: "Linked high", onHandQty: 100, reorderPoint: 10 });
    await store.addBomLineWithInventoryPart(ws, ACTOR, bom.id, {
      partName: "Linked high",
      qty: 1,
      unitCostUsd: 1,
      inventoryPartId: linkedHigh.id,
    });
    // Low in the warehouse, but NOT on any project BOM → not project-relevant.
    await store.createPart(ws, ACTOR, { name: "Unlinked low", onHandQty: 1, reorderPoint: 10 });

    const d = await store.getProjectDashboard(ws, fix.projectId);
    assert.deepEqual(d.lowStockParts.map((p) => p.name), ["Linked low"]);
  });

  it("BOM cost rolls up the latest BOM: known costs sum, unknown lines counted", async () => {
    const ws = await makeWorkspace();
    const fix = await makeRevisionFixture(ws, "dashcost");
    const bom = await store.createBomVersion(ws, ACTOR, fix.modelId, fix.v8.id, "v1");
    const part = await store.createPart(ws, ACTOR, { name: "Carbon arm" });
    const s = await store.createSupplier(ws, ACTOR, { name: "Acme" });
    await store.linkPartSupplier(ws, ACTOR, part.id, s.id, {
      quotedUnitCost: 12.5,
      currency: "USD",
      quotedDate: "2026-09-30",
      quoteSource: "Acme quote PDF Q-4471",
      preferred: true,
    });
    await store.addBomLineWithInventoryPart(ws, ACTOR, bom.id, {
      partName: "Carbon arm",
      qty: 4,
      inventoryPartId: part.id,
    });
    await store.addBomLineWithInventoryPart(ws, ACTOR, bom.id, {
      partName: "Mystery bracket",
      qty: 2,
    });

    const d = await store.getProjectDashboard(ws, fix.projectId);
    assert.equal(d.bomCosts.length, 1);
    const bc = d.bomCosts[0]!;
    assert.equal(bc.modelName, "Airframe");
    assert.equal(bc.knownCostUsd, 50); // 4 × $12.50 from the quoted USD cost
    assert.equal(bc.linesMissingCost, 1); // the mystery bracket, unknown-cost → $0
    assert.equal(d.projectKnownCostUsd, 50);
    assert.ok(bc.basis.includes("BOM #1"));
  });

  it("latestVersions shows the current revision; recentActivity merges task + stock trails", async () => {
    const ws = await makeWorkspace();
    const fix = await makeRevisionFixture(ws, "dashact");
    const task = await store.createTask(ws, ACTOR, fix.projectId, { title: "Watch this" });
    await store.addTaskComment(ws, "dana@test", task.id, "noted");
    const part = await store.createPart(ws, ACTOR, { name: "Prop", onHandQty: 10 });
    await store.adjustStock(ws, ACTOR, part.id, { delta: -2, reason: "bench test" });

    const d = await store.getProjectDashboard(ws, fix.projectId);
    assert.equal(d.latestVersions.length, 1);
    assert.equal(d.latestVersions[0]!.versionNumber, 8);
    assert.equal(d.latestVersions[0]!.versionId, fix.v8.id);

    // The part is not on a project BOM, so its stock event stays out of the
    // project activity — only task trail entries appear.
    const taskTexts = d.recentActivity.filter((a) => a.type === "task");
    assert.ok(taskTexts.length >= 2, "creation + comment events expected");
    assert.ok(taskTexts.every((a) => a.author === ACTOR || a.author === "dana@test"));
    // Newest first.
    for (let i = 1; i < d.recentActivity.length; i++) {
      assert.ok(
        d.recentActivity[i - 1]!.at.getTime() >= d.recentActivity[i]!.at.getTime(),
        "activity must be newest-first",
      );
    }
  });
});

// ============================================================
// F. Tenant isolation everywhere
// ============================================================

describe("tenant isolation", () => {
  it("no cross-workspace reads or writes on any slice-4 path", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const part = await store.createPart(wsA, ACTOR, { name: "A-only", onHandQty: 5 });
    const sup = await store.createSupplier(wsA, ACTOR, { name: "A-only supplier" });
    const fix = await makeRevisionFixture(wsA, "isolation");
    const task = await store.createTask(wsA, ACTOR, fix.projectId, { title: "A-only task" });
    await store.adjustStock(wsA, ACTOR, part.id, { delta: 1, reason: "seed" });

    assert.deepEqual(await store.listParts(wsB), []);
    assert.deepEqual(await store.listSuppliers(wsB), []);
    assert.equal(await codeOf(store.getPart(wsB, part.id)), "PART_NOT_FOUND");
    assert.equal(await codeOf(store.getSupplier(wsB, sup.id)), "SUPPLIER_NOT_FOUND");
    assert.equal(await codeOf(store.adjustStock(wsB, ACTOR, part.id, { delta: 1, reason: "x" })), "PART_NOT_FOUND");
    assert.equal(await codeOf(store.listStockEvents(wsB, part.id)), "PART_NOT_FOUND");
    assert.equal(await codeOf(store.getTask(wsB, task.id)), "TASK_NOT_FOUND");
    assert.equal(await codeOf(store.addTaskComment(wsB, ACTOR, task.id, "hi")), "TASK_NOT_FOUND");
    assert.equal(await codeOf(store.deleteTask(wsB, task.id)), "TASK_NOT_FOUND");
    assert.equal(
      await codeOf(store.linkPartSupplier(wsB, ACTOR, part.id, sup.id, {})),
      "PART_NOT_FOUND",
    );
    assert.equal(await codeOf(store.getProjectDashboard(wsB, fix.projectId)), "PROJECT_NOT_FOUND");
    // And workspace A still sees everything.
    assert.equal((await store.listParts(wsA)).length, 1);
    assert.equal((await store.getTask(wsA, task.id)).task.title, "A-only task");
  });
});
