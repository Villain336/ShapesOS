// ShapesOS — Phase 12 (mfgpos): the manufacturing entities on the Ops
// DocType convention. Each def plugs into OPS_ENTITIES (lib/ops/entities.ts),
// so the generic GET/POST/PATCH /api/ops/{entity} route, workspace scoping,
// audit and the Phase 14 money gate apply by construction. Behaviour lives
// in lib/ops/mfg/service.ts (lazy-imported: it imports the service layer).
//
// Gates: confirming an MO (OPS_MO_CONFIRM), completing it (OPS_MO_COMPLETE —
// stock moves + costing posted to the books, Tier 3) and scrapping stock
// (OPS_SCRAP_POST) never run without an approved Phase 14 approval.
//
// PURE: zod only — no server imports.

import { z } from "zod";
import type { OpsEntityDef } from "../entities";
import { MO_TRANSITIONS, WO_TRANSITIONS } from "./states";

const MAX_CENTS = 2_147_483_647;
const cents = z.number().int().min(0).max(MAX_CENTS);
const id = z.string().min(1).max(64);
const code = z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/, "code may use letters, digits, . _ -");
const isoDateValue = z
  .string()
  .max(64)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: "must be an ISO-8601 date" })
  .transform((v) => new Date(v));

const svc = () => import("./service");

const operationSchema = z.object({
  sequence: z.number().int().min(0).max(10_000),
  name: z.string().trim().min(1).max(200),
  workCenterId: id,
  plannedMinutes: z.number().int().min(0).max(100_000),
});

export const workCenterDef: OpsEntityDef = {
  slug: "work-centers",
  label: "Work centre",
  delegate: "opsWorkCenter",
  createSchema: z.object({
    name: z.string().trim().min(1).max(200),
    code,
    capacity: z.number().int().min(1).max(1000).default(1),
    hourlyCostCents: cents.default(0),
    locationId: id.optional(),
    notes: z.string().max(5000).optional(),
  }),
  // The code is permanent (routings, work orders and the digital twin key on it).
  patchSchema: z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      capacity: z.number().int().min(1).max(1000).optional(),
      hourlyCostCents: cents.optional(),
      locationId: id.nullable().optional(),
      active: z.boolean().optional(),
      notes: z.string().max(5000).nullable().optional(),
    })
    .strict(),
  patchable: true,
  filterable: ["locationId"],
  gatedTransitions: [],
  summarize: (r) => `work centre ${r.code} "${r.name}" (capacity ${r.capacity}, ${r.hourlyCostCents}c/h)`,
  hooks: {
    create: async (tx, a, b) => (await svc()).createWorkCenterRow(tx, a, b),
    patch: async (tx, a, i, p) => (await svc()).patchWorkCenterRow(tx, a, i, p),
  },
};

export const routingDef: OpsEntityDef = {
  slug: "routings",
  label: "Routing",
  delegate: "opsRouting",
  createSchema: z.object({
    productId: id,
    name: z.string().trim().min(1).max(200),
    // The CAD BOM revision the product is built from (its BOM is derived from it).
    bomVersionId: id.optional(),
    operations: z.array(operationSchema).max(100).default([]),
  }),
  patchSchema: z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      bomVersionId: id.nullable().optional(),
      operations: z.array(operationSchema).max(100).optional(),
      active: z.boolean().optional(),
    })
    .strict(),
  patchable: true,
  filterable: ["productId", "bomVersionId"],
  gatedTransitions: [],
  summarize: (r) => `routing "${r.name}" for product ${r.productId} (${Array.isArray(r.operations) ? r.operations.length : 0} steps)`,
  hooks: {
    create: async (tx, a, b) => (await svc()).createRoutingRow(tx, a, b),
    patch: async (tx, a, i, p) => (await svc()).patchRoutingRow(tx, a, i, p),
  },
};

export const manufacturingOrderDef: OpsEntityDef = {
  slug: "manufacturing-orders",
  label: "Manufacturing order",
  delegate: "opsManufacturingOrder",
  createSchema: z.object({
    productId: id,
    variantId: id.optional(),
    qty: z.number().int().min(1).max(1_000_000),
    // Defaults to the product's active routing (and its CAD BOM revision).
    routingId: id.optional(),
    bomVersionId: id.optional(),
    componentLocationId: id.optional(),
    finishedLocationId: id.optional(),
    plannedStart: isoDateValue.optional(),
    note: z.string().max(5000).optional(),
  }),
  patchSchema: z
    .object({
      status: z.enum(["confirmed", "in_progress", "done", "cancelled"]).optional(),
      // With status "done": what came out (defaults: the whole quantity, no scrap).
      producedQty: z.number().int().min(0).max(1_000_000).optional(),
      scrappedQty: z.number().int().min(0).max(1_000_000).optional(),
      // Draft-only plan edits.
      qty: z.number().int().min(1).max(1_000_000).optional(),
      variantId: id.nullable().optional(),
      routingId: id.nullable().optional(),
      bomVersionId: id.nullable().optional(),
      componentLocationId: id.nullable().optional(),
      finishedLocationId: id.nullable().optional(),
      plannedStart: isoDateValue.nullable().optional(),
      note: z.string().max(5000).nullable().optional(),
    }),
  // (not .strict(): a gated PATCH carries approvalId beside the patch)
  patchable: true,
  filterable: ["status", "productId", "routingId"],
  gatedTransitions: [
    { field: "status", to: ["confirmed"], slug: "OPS_MO_CONFIRM", label: "Confirm manufacturing order" },
    { field: "status", to: ["done"], slug: "OPS_MO_COMPLETE", label: "Complete manufacturing order" },
  ],
  statusTransitions: MO_TRANSITIONS as unknown as Record<string, string[]>,
  summarize: (r) =>
    `manufacturing order ${r.number ?? r.id} → ${r.status}: ${r.qty} × product ${r.productId}` +
    (r.producedQty || r.scrappedQty ? ` (produced ${r.producedQty ?? 0}, scrapped ${r.scrappedQty ?? 0})` : ""),
  hooks: {
    create: async (tx, a, b) => (await svc()).createMoRow(tx, a, b),
    patch: async (tx, a, i, p, e) => (await svc()).patchMo(tx, a, i, p, e),
  },
};

export const workOrderDef: OpsEntityDef = {
  slug: "work-orders",
  label: "Work order",
  delegate: "opsWorkOrder",
  // Created by confirming an MO (the hook refuses direct creates with 405).
  createSchema: z.object({ moId: id }),
  // in_progress = start / resume the timer; paused / done stop it (logged).
  patchSchema: z.object({ status: z.enum(["in_progress", "paused", "done", "cancelled"]) }).strict(),
  patchable: true,
  filterable: ["moId", "workCenterId", "status"],
  gatedTransitions: [],
  statusTransitions: WO_TRANSITIONS as unknown as Record<string, string[]>,
  summarize: (r) => `work order ${r.sequence}. "${r.name}" of MO ${r.moId} → ${r.status} (${Math.round(Number(r.actualSeconds ?? 0) / 60)} min)`,
  hooks: {
    create: async () => (await svc()).createWorkOrderRow(),
    patch: async (tx, a, i, p, e) => (await svc()).patchWorkOrder(tx, a, i, p, e),
  },
};

export const workTimeLogDef: OpsEntityDef = {
  slug: "work-time-logs",
  label: "Work time log",
  delegate: "opsWorkTimeLog",
  // A manual entry; timer segments are written by the work-order timer.
  createSchema: z.object({
    workOrderId: id,
    minutes: z.number().positive().max(24 * 60),
    endedAt: isoDateValue.optional(),
    note: z.string().max(2000).optional(),
  }),
  patchSchema: z.object({}),
  // Append-only: corrections are new entries.
  patchable: false,
  filterable: ["workOrderId", "userId", "source"],
  gatedTransitions: [],
  summarize: (r) => `${Math.round(Number(r.seconds ?? 0) / 60)} min logged on work order ${r.workOrderId} (${r.source})`,
  hooks: { create: async (tx, a, b) => (await svc()).createTimeLogRow(tx, a, b) },
};

export const scrapDef: OpsEntityDef = {
  slug: "scraps",
  label: "Scrap",
  delegate: "opsScrap",
  createSchema: z.object({
    productId: id,
    variantId: id.optional(),
    qty: z.number().int().min(1).max(1_000_000),
    locationId: id.optional(),
    reason: z.string().trim().min(1).max(500),
    // Value per unit; defaults to the product's last manufactured unit cost.
    unitCostCents: cents.optional(),
  }),
  patchSchema: z.object({}),
  patchable: false,
  filterable: ["productId", "moId", "locationId"],
  gatedTransitions: [],
  // Writes stock and its value off the books — always a gated write.
  createGate: "OPS_SCRAP_POST",
  summarize: (r) => `scrap ${r.qty} × product ${r.productId} (${r.reason})${r.totalCostCents ? ` — ${r.totalCostCents}c` : ""}`,
  hooks: { create: async (tx, a, b) => (await svc()).createScrapRow(tx, a, b) },
};

export const MFG_ENTITIES: OpsEntityDef[] = [workCenterDef, routingDef, manufacturingOrderDef, workOrderDef, workTimeLogDef, scrapDef];
