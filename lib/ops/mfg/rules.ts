// ShapesOS — Phase 12 (mfgpos): manufacturing rules. PURE (no I/O), so every
// rule is unit-tested on its own (lib/ops/__tests__/p12-mfg.test.ts).
//
//   MO state machine   draft → confirmed → in_progress → done
//                      cancelled from draft / confirmed / in_progress (nothing
//                      has moved yet: stock and the books only change on done)
//   components         snapshotted at confirm from the CAD BOM revision
//                      (CadBomLine → CadPart.opsProductId → OpsProduct) — the
//                      CAD BOM is the only BOM; this is a derived view of it
//   consumption        ceil(qtyPerUnit × units started) per component, where
//                      units started = produced + scrapped (partial runs
//                      consume only for what was actually made or spoiled)
//   costing            components (consumed × unit cost) + labour (logged
//                      seconds × work-centre hourly rate), split between
//                      finished goods and scrap by units
//   routing            operations ordered by sequence; sequences unique
//   work-order timer   start / pause / finish → time segments
//
// Integer cents and whole units everywhere a stock move or money is
// involved; BOM quantities may be fractional (CadBomLine.qty is a float).

import { divRoundHalfUp } from "../finance/money";
import { OpsError } from "../doctype";
import { MO_STATUSES, MO_TRANSITIONS, WO_TRANSITIONS, type MoStatus } from "./states";

export { MO_STATUSES, MO_TRANSITIONS, WO_TRANSITIONS, type MoStatus };

// ---------------------------------------------------------------------------
// Manufacturing order state machine
// ---------------------------------------------------------------------------

export function canMoveMo(from: string, to: string): boolean {
  return (MO_TRANSITIONS[from as MoStatus] ?? []).includes(to as MoStatus);
}

export function assertMoTransition(from: string, to: string): void {
  if (!canMoveMo(from, to)) throw new OpsError(409, `A manufacturing order can't move from ${from.replace("_", " ")} to ${to.replace("_", " ")}`);
}

/** Fields a person may still edit, by status (draft only — confirm freezes the plan). */
export const MO_EDITABLE_FIELDS = ["qty", "note", "plannedStart", "routingId", "bomVersionId", "componentLocationId", "finishedLocationId", "variantId"] as const;

// ---------------------------------------------------------------------------
// Routing operations
// ---------------------------------------------------------------------------

export interface RoutingOperation {
  sequence: number;
  name: string;
  workCenterId: string;
  /** Planned minutes per unit. */
  plannedMinutes: number;
}

/** Sort by sequence; sequences must be unique whole numbers ≥ 0, names non-empty. */
export function orderOperations(ops: RoutingOperation[]): RoutingOperation[] {
  const seen = new Set<number>();
  for (const o of ops) {
    if (!Number.isInteger(o.sequence) || o.sequence < 0) throw new OpsError(422, `Operation "${o.name}": sequence must be a whole number ≥ 0`);
    if (seen.has(o.sequence)) throw new OpsError(422, `Two operations share sequence ${o.sequence} — each step needs its own place in the routing`);
    seen.add(o.sequence);
    if (!o.name?.trim()) throw new OpsError(422, "Every operation needs a name");
    if (!Number.isInteger(o.plannedMinutes) || o.plannedMinutes < 0) throw new OpsError(422, `Operation "${o.name}": planned minutes must be a whole number ≥ 0`);
  }
  return [...ops].sort((a, b) => a.sequence - b.sequence);
}

/** Work orders an MO gets on confirm: one per operation, minutes scaled to the quantity. */
export function plannedWorkOrders(ops: RoutingOperation[], qty: number): Array<RoutingOperation & { plannedMinutes: number }> {
  return orderOperations(ops).map((o) => ({ ...o, plannedMinutes: o.plannedMinutes * qty }));
}

// ---------------------------------------------------------------------------
// Components (derived from the CAD BOM)
// ---------------------------------------------------------------------------

export interface BomLineLike {
  id: string;
  partName: string;
  qty: number;
  unitCostUsd: number | null;
  /** The linked CAD part's Ops product (null = not a stocked component). */
  productId: string | null;
  productSku?: string | null;
  partSku?: string | null;
  /** Whether that product tracks inventory. */
  trackInventory?: boolean;
}

export interface MoComponent {
  bomLineId: string;
  productId: string | null;
  name: string;
  sku: string | null;
  /** Per finished unit (may be fractional). */
  qtyPerUnit: number;
  /** Unit cost in cents (CAD BOM USD cost, rounded; 0 = unknown). */
  unitCostCents: number;
  /** True when the component moves through the stock ledger. */
  stocked: boolean;
  /** Set on completion. */
  consumedQty?: number;
}

/** The product-level BOM view: CAD BOM lines → MO components. */
export function componentsFromBom(lines: BomLineLike[]): MoComponent[] {
  return lines
    .filter((l) => Number.isFinite(l.qty) && l.qty > 0)
    .map((l) => ({
      bomLineId: l.id,
      productId: l.productId,
      name: l.partName,
      sku: l.productSku ?? l.partSku ?? null,
      qtyPerUnit: l.qty,
      unitCostCents: l.unitCostUsd != null && Number.isFinite(l.unitCostUsd) && l.unitCostUsd > 0 ? Math.round(l.unitCostUsd * 100) : 0,
      stocked: Boolean(l.productId && l.trackInventory !== false),
    }));
}

/** Whole units of one component used for `units` finished (or spoiled) units. */
export function consumptionQty(qtyPerUnit: number, units: number): number {
  if (units <= 0 || qtyPerUnit <= 0) return 0;
  // Round away float noise (0.1 × 30 = 3.0000000000000004) before the ceiling.
  const exact = Math.round(qtyPerUnit * units * 1e6) / 1e6;
  return Math.ceil(exact);
}

export interface CompletionInput {
  qty: number;
  producedQty?: number;
  scrappedQty?: number;
}

/** Validate the completion quantities: produced + scrapped ≥ 1 and ≤ the MO quantity. */
export function completionQuantities(input: CompletionInput): { producedQty: number; scrappedQty: number; unitsStarted: number } {
  const scrappedQty = input.scrappedQty ?? 0;
  const producedQty = input.producedQty ?? input.qty - scrappedQty;
  for (const [k, v] of [["producedQty", producedQty], ["scrappedQty", scrappedQty]] as const) {
    if (!Number.isInteger(v) || v < 0) throw new OpsError(422, `${k} must be a whole number ≥ 0`);
  }
  const unitsStarted = producedQty + scrappedQty;
  if (unitsStarted < 1) throw new OpsError(422, "Produce or scrap at least one unit to complete the order");
  if (unitsStarted > input.qty) {
    throw new OpsError(422, `Produced (${producedQty}) plus scrapped (${scrappedQty}) can't exceed the order quantity (${input.qty})`);
  }
  return { producedQty, scrappedQty, unitsStarted };
}

export interface ConsumptionLine extends MoComponent {
  consumedQty: number;
  costCents: number;
}

export function consumption(components: MoComponent[], unitsStarted: number): ConsumptionLine[] {
  return components.map((c) => {
    const consumedQty = consumptionQty(c.qtyPerUnit, unitsStarted);
    return { ...c, consumedQty, costCents: consumedQty * c.unitCostCents };
  });
}

// ---------------------------------------------------------------------------
// Costing
// ---------------------------------------------------------------------------

/** Labour cost of one work order: seconds × hourly rate, rounded half-up once. */
export function labourCents(actualSeconds: number, hourlyCostCents: number): number {
  if (actualSeconds <= 0 || hourlyCostCents <= 0) return 0;
  return divRoundHalfUp(actualSeconds * hourlyCostCents, 3600);
}

export interface MoCostResult {
  componentCostCents: number;
  labourCostCents: number;
  finishedCostCents: number;
  scrapCostCents: number;
  /** Per finished unit (0 when nothing was finished). */
  unitCostCents: number;
}

/**
 * Total = components + labour; the scrapped share is total × scrapped /
 * units started (rounded half-up), the rest is finished-goods value — the
 * two parts always add back to the total exactly.
 */
export function moCosting(
  lines: Array<{ costCents: number }>,
  workOrders: Array<{ actualSeconds: number; hourlyCostCents: number }>,
  producedQty: number,
  scrappedQty: number,
): MoCostResult {
  const componentCostCents = lines.reduce((s, l) => s + l.costCents, 0);
  const labourCostCents = workOrders.reduce((s, w) => s + labourCents(w.actualSeconds, w.hourlyCostCents), 0);
  const total = componentCostCents + labourCostCents;
  const started = producedQty + scrappedQty;
  const scrapCostCents = started > 0 && scrappedQty > 0 ? divRoundHalfUp(total * scrappedQty, started) : 0;
  const finishedCostCents = total - scrapCostCents;
  return {
    componentCostCents,
    labourCostCents,
    finishedCostCents,
    scrapCostCents,
    unitCostCents: producedQty > 0 ? divRoundHalfUp(finishedCostCents, producedQty) : 0,
  };
}

// ---------------------------------------------------------------------------
// Work-order timer
// ---------------------------------------------------------------------------

export function assertWoTransition(from: string, to: string): void {
  if (!(WO_TRANSITIONS[from] ?? []).includes(to)) {
    throw new OpsError(409, `A work order can't move from ${from.replace("_", " ")} to ${to.replace("_", " ")}`);
  }
}

export interface TimerState {
  status: string;
  runningSince: Date | null;
  actualSeconds: number;
}

export interface TimerStep {
  status: string;
  runningSince: Date | null;
  actualSeconds: number;
  /** A closed time segment to log (pause / finish while running). */
  segment: { startedAt: Date; endedAt: Date; seconds: number } | null;
}

/** Apply a start / pause / finish to a work order's timer. */
export function timerStep(state: TimerState, to: "in_progress" | "paused" | "done" | "cancelled", now: Date): TimerStep {
  assertWoTransition(state.status, to);
  if (to === "in_progress") return { status: to, runningSince: now, actualSeconds: state.actualSeconds, segment: null };
  let segment: TimerStep["segment"] = null;
  let actual = state.actualSeconds;
  if (state.status === "in_progress" && state.runningSince) {
    const seconds = Math.max(0, Math.floor((now.getTime() - state.runningSince.getTime()) / 1000));
    segment = { startedAt: state.runningSince, endedAt: now, seconds };
    actual += seconds;
  }
  return { status: to, runningSince: null, actualSeconds: actual, segment };
}

/** Is there room at a work centre? (capacity = work orders it runs at once) */
export function hasCapacity(capacity: number, runningNow: number): boolean {
  return runningNow < Math.max(1, capacity);
}
