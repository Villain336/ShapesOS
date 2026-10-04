// ShapesOS — Phase 13 (twincore): the digital twin entities on the Ops
// DocType convention. Each def plugs into OPS_ENTITIES (lib/ops/entities.ts)
// so the generic GET/POST/PATCH /api/ops/{entity} route, workspace scoping,
// audit and the Phase 14 gate apply by construction:
//
//   /api/ops/twin-sites      a site over a warehouse; draft → published is a
//                            GATED move (OPS_TWIN_SITE_PUBLISH: a person
//                            approves the layout agents drafted)
//   /api/ops/twin-objects    laid-out objects + their binding; equipment
//                            "assign / free" is a PATCH of equipmentStatus /
//                            taskLocationId / taskNote
//   /api/ops/dock-bookings   "book a dock" is a POST; "advance a booking"
//                            is a PATCH of status (booked → arrived →
//                            loading | unloading → done, any active →
//                            cancelled)
//
// Behaviour (layout validation, same-workspace bindings, dock clashes) lives
// in lib/ops/twin/service.ts (lazy-imported). PURE: zod only.

import { z } from "zod";
import type { OpsEntityDef } from "../entities";
import { BOOKING_TRANSITIONS, SITE_TRANSITIONS } from "@/lib/twin/derive";
import { TWIN_OBJECT_KINDS, TWIN_SITE_KINDS } from "@/lib/twin/types";

const id = z.string().min(1).max(64);
const cell = z.number().int().min(0).max(400);
const span = z.number().int().min(1).max(400);
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const bindingType = z.enum(["location", "work_center", "register", "product"]);
const code = z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/, "code may use letters, digits, . _ -");
const isoDateValue = z
  .string()
  .max(64)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: "must be an ISO-8601 date" })
  .transform((v) => new Date(v));

const svc = () => import("./service");

export const twinSiteDef: OpsEntityDef = {
  slug: "twin-sites",
  label: "Twin site",
  delegate: "opsSite",
  createSchema: z.object({
    kind: z.enum(TWIN_SITE_KINDS),
    name: z.string().trim().min(1).max(200),
    code,
    gridW: z.number().int().min(4).max(400),
    gridD: z.number().int().min(4).max(400),
    warehouseId: id,
    notes: z.string().max(5000).optional(),
  }),
  // (not .strict(): a gated publish carries approvalId beside the patch)
  patchSchema: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    gridW: z.number().int().min(4).max(400).optional(),
    gridD: z.number().int().min(4).max(400).optional(),
    notes: z.string().max(5000).nullable().optional(),
    status: z.enum(["draft", "published"]).optional(),
  }),
  patchable: true,
  filterable: ["kind", "status", "warehouseId"],
  gatedTransitions: [{ field: "status", to: ["published"], slug: "OPS_TWIN_SITE_PUBLISH", label: "Publish twin site layout" }],
  statusTransitions: SITE_TRANSITIONS as unknown as Record<string, string[]>,
  summarize: (r) => `twin site ${r.code} "${r.name}" (${r.kind}, ${r.gridW}×${r.gridD}) → ${r.status}`,
  hooks: {
    create: async (tx, a, b) => (await svc()).createSiteRow(tx, a, b),
    patch: async (tx, a, i, p, e) => (await svc()).patchSiteRow(tx, a, i, p, e),
  },
};

export const twinObjectDef: OpsEntityDef = {
  slug: "twin-objects",
  label: "Twin object",
  delegate: "opsSiteObject",
  createSchema: z.object({
    siteId: id,
    kind: z.enum(TWIN_OBJECT_KINDS),
    label: z.string().trim().min(1).max(120),
    x: cell,
    z: cell,
    w: span.default(1),
    d: span.default(1),
    h: z.number().int().min(1).max(50).default(1),
    rotation: rotation.default(0),
    bindingType: bindingType.optional(),
    bindingId: id.optional(),
    // equipment only
    equipmentStatus: z.enum(["available", "busy", "charging"]).optional(),
    homeX: cell.optional(),
    homeZ: cell.optional(),
  }),
  patchSchema: z
    .object({
      label: z.string().trim().min(1).max(120).optional(),
      x: cell.optional(),
      z: cell.optional(),
      w: span.optional(),
      d: span.optional(),
      h: z.number().int().min(1).max(50).optional(),
      rotation: rotation.optional(),
      bindingType: bindingType.nullable().optional(),
      bindingId: id.nullable().optional(),
      // equipment only: assign (busy + task) / free (available) / charging
      equipmentStatus: z.enum(["available", "busy", "charging"]).optional(),
      taskLocationId: id.nullable().optional(),
      taskNote: z.string().trim().max(500).nullable().optional(),
      homeX: cell.optional(),
      homeZ: cell.optional(),
    })
    .strict(),
  patchable: true,
  filterable: ["siteId", "kind", "bindingType", "bindingId"],
  gatedTransitions: [],
  summarize: (r) =>
    `twin ${String(r.kind).replace("_", " ")} "${r.label}" at ${r.x},${r.z} (${r.w}×${r.d})` +
    (r.bindingId ? ` bound to ${r.bindingType} ${r.bindingId}` : "") +
    (r.equipmentStatus ? ` — ${r.equipmentStatus}${r.taskNote ? `: ${r.taskNote}` : ""}` : ""),
  hooks: {
    create: async (tx, a, b) => (await svc()).createObjectRow(tx, a, b),
    patch: async (tx, a, i, p, e) => (await svc()).patchObjectRow(tx, a, i, p, e),
    // Phase 13 (twinui): the layout editor's Delete (generic DELETE route).
    remove: async (tx, a, i, e) => (await import("./remove")).removeObjectRow(tx, a, i, e),
  },
};

export const dockBookingDef: OpsEntityDef = {
  slug: "dock-bookings",
  label: "Dock booking",
  delegate: "opsDockBooking",
  createSchema: z
    .object({
      siteId: id,
      // The dock: its location, or the twin object drawn for it.
      dockLocationId: id.optional(),
      dockObjectId: id.optional(),
      // Inferred from what it serves when omitted (PO → inbound, order → outbound).
      direction: z.enum(["inbound", "outbound"]).optional(),
      carrier: z.string().trim().max(120).optional(),
      truckRef: z.string().trim().max(64).optional(),
      purchaseOrderId: id.optional(),
      orderId: id.optional(),
      transferId: id.optional(),
      eta: isoDateValue,
      durationMinutes: z.number().int().min(5).max(1440).default(60),
      notes: z.string().max(5000).optional(),
    })
    .refine((b) => Boolean(b.dockLocationId || b.dockObjectId), { message: "dockLocationId or dockObjectId is required", path: ["dockLocationId"] })
    .refine((b) => [b.purchaseOrderId, b.orderId, b.transferId].filter(Boolean).length <= 1, {
      message: "a booking serves at most one of purchaseOrderId, orderId, transferId",
      path: ["purchaseOrderId"],
    }),
  patchSchema: z
    .object({
      status: z.enum(["arrived", "loading", "unloading", "done", "cancelled"]).optional(),
      eta: isoDateValue.optional(),
      durationMinutes: z.number().int().min(5).max(1440).optional(),
      carrier: z.string().trim().max(120).nullable().optional(),
      truckRef: z.string().trim().max(64).nullable().optional(),
      notes: z.string().max(5000).nullable().optional(),
    })
    .strict(),
  patchable: true,
  filterable: ["siteId", "dockLocationId", "status", "direction"],
  gatedTransitions: [],
  statusTransitions: BOOKING_TRANSITIONS as unknown as Record<string, string[]>,
  summarize: (r) =>
    `${r.direction} truck ${r.truckRef ?? r.carrier ?? r.id} at dock ${r.dockLocationId}, eta ${r.eta instanceof Date ? r.eta.toISOString() : String(r.eta)} → ${r.status}`,
  hooks: {
    create: async (tx, a, b) => (await svc()).createBookingRow(tx, a, b),
    patch: async (tx, a, i, p, e) => (await svc()).patchBookingRow(tx, a, i, p, e),
  },
};

export const TWIN_ENTITIES: OpsEntityDef[] = [twinSiteDef, twinObjectDef, dockBookingDef];
