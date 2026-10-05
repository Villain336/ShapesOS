// ShapesOS — Phase 12 (mfgpos): the point-of-sale entities on the Ops
// DocType convention (generic /api/ops/{entity} route, scoping, audit, gate).
// Behaviour lives in lib/ops/pos/service.ts (lazy-imported).
//
// Closing a till session posts the day's takings to the books — a gated
// write (OPS_POS_SESSION_CLOSE, Tier 3: never automated). Sales are rung up
// through POST /api/ops/pos/sessions/{id}/sales, not through this registry.
//
// PURE: zod only — no server imports.

import { z } from "zod";
import type { OpsEntityDef } from "../entities";
import { POS_SESSION_TRANSITIONS } from "./states";

const MAX_CENTS = 2_147_483_647;
const cents = z.number().int().min(0).max(MAX_CENTS);
const id = z.string().min(1).max(64);
const readerId = z.string().trim().max(64).regex(/^tmr_[A-Za-z0-9]+$/, "a Stripe Terminal reader id looks like tmr_…");

const svc = () => import("./service");

export const posRegisterDef: OpsEntityDef = {
  slug: "pos-registers",
  createEntitlement: "pos", // Phase 15.3 (pricing): POS is Pro and up
  label: "Register",
  delegate: "opsPosRegister",
  createSchema: z.object({
    name: z.string().trim().min(1).max(120),
    locationId: id.optional(),
    taxRateId: id.optional(),
    terminalReaderId: readerId.optional(),
  }),
  patchSchema: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      locationId: id.nullable().optional(),
      taxRateId: id.nullable().optional(),
      terminalReaderId: readerId.nullable().optional(),
      active: z.boolean().optional(),
    })
    .strict(),
  patchable: true,
  filterable: ["locationId"],
  gatedTransitions: [],
  summarize: (r) => `register "${r.name}"${r.terminalReaderId ? ` (reader ${r.terminalReaderId})` : ""}`,
  hooks: {
    create: async (tx, a, b) => (await svc()).createRegisterRow(tx, a, b),
    patch: async (tx, a, i, p) => (await svc()).patchRegisterRow(tx, a, i, p),
  },
};

export const posSessionDef: OpsEntityDef = {
  slug: "pos-sessions",
  createEntitlement: "pos", // Phase 15.3: opening a till is a POS entry point
  label: "Till session",
  delegate: "opsPosSession",
  // Opening a till: the cash float in the drawer.
  createSchema: z.object({
    registerId: id,
    openingCashCents: cents,
    note: z.string().max(2000).optional(),
  }),
  // closing = cash counted (no more sales); open = re-open for a recount;
  // closed = post the takings (gated).
  patchSchema: z
    .object({
      status: z.enum(["closing", "open", "closed"]).optional(),
      countedCashCents: cents.optional(),
      note: z.string().max(2000).nullable().optional(),
    }),
  // (not .strict(): a gated PATCH carries approvalId beside the patch)
  patchable: true,
  filterable: ["registerId", "status"],
  gatedTransitions: [{ field: "status", to: ["closed"], slug: "OPS_POS_SESSION_CLOSE", label: "Close till session" }],
  statusTransitions: POS_SESSION_TRANSITIONS as unknown as Record<string, string[]>,
  summarize: (r) =>
    `till session ${r.number ?? r.id} → ${r.status}` +
    (r.countedCashCents != null ? ` (counted ${r.countedCashCents}c, expected ${r.expectedCashCents ?? "?"}c)` : ` (float ${r.openingCashCents}c)`),
  hooks: {
    create: async (tx, a, b) => (await svc()).openSessionRow(tx, a, b),
    patch: async (tx, a, i, p, e) => (await svc()).patchSession(tx, a, i, p, e),
  },
};

export const POS_ENTITIES: OpsEntityDef[] = [posRegisterDef, posSessionDef];
