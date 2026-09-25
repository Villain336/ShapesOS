// Marketr — EDDM concierge service (Phase 4, Track T3).
//
// EDDM (Every Door Direct Mail) has NO USPS API — execution is always
// human/mailhouse. This module is the concierge brain: route math, cost
// estimates, status transitions with validation, per-drop QR slug minting,
// and the attribution hook. Money rule: estimates only, no real spend,
// no API send path implied anywhere.
//
// Grounded facts (docs/phase4-research.md §EDDM key facts, task brief):
//   - EDDM Retail postage: $0.260/pc (2026); BMEU entry: $0.259/pc.
//   - EDDM Retail minimum: 200 pieces per mailing (per ZIP per day).
//   - Flats only: minimum finished size 6.125" x 11.5" — a 4x6 postcard
//     does NOT qualify (enforced on the creative, not here).
//   - All-in typical: $0.35–$0.57/pc (postage + print + prep).

import { randomBytes } from "node:crypto";
import { Prisma, type EddmOrder, type MailCreative } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// NOTE: EddmOrder carries creativeId as a plain scalar — there is no Prisma
// relation to MailCreative (schema change is out of scope), so creatives are
// fetched separately and attached by the helpers below.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** EDDM Retail postage, cents per piece (2026 rate). */
export const EDDM_POSTAGE_RETAIL_CENTS_PER_PIECE = 26.0;
/** EDDM postage via BMEU entry, cents per piece (2026 rate). */
export const EDDM_POSTAGE_BMEU_CENTS_PER_PIECE = 25.9;
/** EDDM Retail minimum pieces per selected route. */
export const EDDM_RETAIL_MIN_PIECES_PER_ROUTE = 200;
/** Editable default print+prep assumption, cents per piece. Estimates only. */
export const EDDM_DEFAULT_PRINT_CENTS_PER_PIECE = 12.0;
/** In-home window: drop date + 3 to + 7 days (USPS transit for EDDM). */
export const EDDM_IN_HOME_MIN_DAYS = 3;
export const EDDM_IN_HOME_MAX_DAYS = 7;

export type EddmPostageTier = "retail" | "bmeu";

export type EddmStatus =
  | "draft"
  | "briefed"
  | "at_mailhouse"
  | "dropped"
  | "complete"
  | "cancelled";

export const EDDM_STATUSES: EddmStatus[] = [
  "draft",
  "briefed",
  "at_mailhouse",
  "dropped",
  "complete",
  "cancelled",
];

export interface EddmRouteRow {
  zip: string;
  routeId: string;
  households: number;
  selected: boolean;
}

const ZIP_RE = /^\d{5}(-\d{4})?$/;

// ---------------------------------------------------------------------------
// Route validation + math
// ---------------------------------------------------------------------------

export interface EddmRoutesValidation {
  ok: boolean;
  errors: string[];
  /** Sum of households across selected routes. */
  pieceCount: number;
  selectedCount: number;
}

/**
 * Validate a manual-entry carrier-route table. v1 is manual entry — the UI
 * carries a "verify with mailhouse" note because route counts come from
 * USPS EDDM data the mailhouse confirms.
 */
export function validateEddmRoutes(
  routes: unknown,
  postageTier: EddmPostageTier = "retail",
): EddmRoutesValidation {
  const errors: string[] = [];
  if (!Array.isArray(routes) || routes.length === 0) {
    return { ok: false, errors: ["Add at least one carrier route."], pieceCount: 0, selectedCount: 0 };
  }
  let pieceCount = 0;
  let selectedCount = 0;
  const seen = new Set<string>();
  routes.forEach((r, i) => {
    const row = r as Partial<EddmRouteRow>;
    const label = `Row ${i + 1}`;
    const zip = String(row.zip ?? "").trim();
    const routeId = String(row.routeId ?? "").trim();
    const households = Number(row.households);
    const selected = row.selected !== false;
    if (!ZIP_RE.test(zip)) errors.push(`${label}: ZIP "${zip || "—"}" is not a valid 5-digit ZIP.`);
    if (!routeId) errors.push(`${label}: route ID is required (e.g. C001).`);
    if (!Number.isFinite(households) || households < 1 || !Number.isInteger(households)) {
      errors.push(`${label}: households must be a positive whole number.`);
    }
    const key = `${zip}:${routeId.toUpperCase()}`;
    if (zip && routeId) {
      if (seen.has(key)) errors.push(`${label}: duplicate route ${zip} ${routeId}.`);
      seen.add(key);
    }
    if (selected && Number.isFinite(households) && households > 0) {
      selectedCount += 1;
      pieceCount += households;
      if (
        postageTier === "retail" &&
        households < EDDM_RETAIL_MIN_PIECES_PER_ROUTE
      ) {
        errors.push(
          `${label}: ${zip} ${routeId} has ${households} households — EDDM Retail requires a minimum of ${EDDM_RETAIL_MIN_PIECES_PER_ROUTE} pieces per route.`,
        );
      }
    }
  });
  if (selectedCount === 0) errors.push("Select at least one route for this drop.");
  return { ok: errors.length === 0, errors, pieceCount, selectedCount };
}

/** Coerce a raw routes JSON value into typed rows (defensive for Json). */
export function coerceEddmRoutes(routes: unknown): EddmRouteRow[] {
  if (!Array.isArray(routes)) return [];
  return routes.map((r) => {
    const row = r as Partial<EddmRouteRow>;
    return {
      zip: String(row.zip ?? "").trim(),
      routeId: String(row.routeId ?? "").trim(),
      households: Number(row.households ?? 0),
      selected: row.selected !== false,
    };
  });
}

// ---------------------------------------------------------------------------
// Cost estimate
// ---------------------------------------------------------------------------

export interface EddmEstimateInput {
  routes: EddmRouteRow[];
  postageTier?: EddmPostageTier;
  /** Cents per piece for print + prep. Defaults to the editable assumption. */
  printCentsPerPiece?: number;
}

export interface EddmEstimate {
  pieceCount: number;
  selectedRoutes: number;
  postageTier: EddmPostageTier;
  postageCentsPerPiece: number;
  printCentsPerPiece: number;
  perPieceCents: number;
  postageCents: number;
  printCents: number;
  totalCents: number;
  /** True when any input was clamped or defaulted (surfaced in the UI). */
  usedDefaults: boolean;
}

/** Pure cost math: pieceCount x postage + print = totals. All in cents. */
export function estimateEddmCost(input: EddmEstimateInput): EddmEstimate {
  const selected = (input.routes ?? []).filter((r) => r.selected !== false);
  const pieceCount = selected.reduce(
    (sum, r) => sum + (Number.isFinite(r.households) && r.households > 0 ? Math.floor(r.households) : 0),
    0,
  );
  const postageTier: EddmPostageTier = input.postageTier === "bmeu" ? "bmeu" : "retail";
  const postageCentsPerPiece =
    postageTier === "bmeu" ? EDDM_POSTAGE_BMEU_CENTS_PER_PIECE : EDDM_POSTAGE_RETAIL_CENTS_PER_PIECE;
  const printRaw = input.printCentsPerPiece;
  const usedDefaults = printRaw == null || !(printRaw >= 0);
  const printCentsPerPiece =
    usedDefaults || !Number.isFinite(printRaw) || (printRaw as number) < 0
      ? EDDM_DEFAULT_PRINT_CENTS_PER_PIECE
      : (printRaw as number);
  const postageCents = Math.round(pieceCount * postageCentsPerPiece);
  const printCents = Math.round(pieceCount * printCentsPerPiece);
  const totalCents = postageCents + printCents;
  return {
    pieceCount,
    selectedRoutes: selected.length,
    postageTier,
    postageCentsPerPiece,
    printCentsPerPiece,
    perPieceCents: pieceCount > 0 ? totalCents / pieceCount : 0,
    postageCents,
    printCents,
    totalCents,
    usedDefaults,
  };
}

/** In-home target window from a drop date: drop + 3 to + 7 days. */
export function eddmInHomeWindow(dropDate: Date): { start: Date; end: Date } {
  const start = new Date(dropDate);
  start.setDate(start.getDate() + EDDM_IN_HOME_MIN_DAYS);
  const end = new Date(dropDate);
  end.setDate(end.getDate() + EDDM_IN_HOME_MAX_DAYS);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

const EDDM_TRANSITIONS: Record<EddmStatus, EddmStatus[]> = {
  draft: ["briefed", "cancelled"],
  briefed: ["at_mailhouse", "cancelled"],
  at_mailhouse: ["dropped", "cancelled"],
  dropped: ["complete"],
  complete: [],
  cancelled: [],
};

/** Throw unless `to` is a legal transition from `from`. */
export function assertEddmTransition(from: string, to: string): asserts to is EddmStatus {
  if (!EDDM_STATUSES.includes(to as EddmStatus)) {
    throw new Error(`Unknown EDDM status "${to}".`);
  }
  const allowed = EDDM_TRANSITIONS[from as EddmStatus] ?? [];
  if (!allowed.includes(to as EddmStatus)) {
    throw new Error(
      `Illegal EDDM transition: ${from} → ${to}. Allowed: ${allowed.length ? allowed.join(", ") : "none"}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// QR slug minting (per-drop, bundle-style uniqueness)
// ---------------------------------------------------------------------------

function randomSlugSuffix(bytes = 5): string {
  return randomBytes(bytes).toString("hex");
}

/** Globally unique per-drop slug, minted like bundle vanity slugs. */
export async function mintEddmQrSlug(prefix = "eddm"): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const slug = `${prefix}-${randomSlugSuffix()}`;
    const hit = await prisma.eddmOrder.findUnique({
      where: { qrSlug: slug },
      select: { id: true },
    });
    if (!hit) return slug;
  }
  throw new Error("Could not mint a unique EDDM QR slug");
}

/** Reserved public URL shape for the drop's QR/pURL. Scan routing wires in
 * with the T1 mail tracking work — the brief labels it accordingly so a
 * printed piece never promises a live URL that 404s. */
export function eddmDropUrl(slug: string, origin: string): string {
  return `${origin.replace(/\/$/, "")}/r/${slug}`;
}

// ---------------------------------------------------------------------------
// Order CRUD (workspace-scoped)
// ---------------------------------------------------------------------------

export async function getEddmOrder(workspaceId: string, id: string): Promise<EddmOrder | null> {
  return prisma.eddmOrder.findFirst({ where: { id, workspaceId } });
}

/** Order + its bound creative (creativeId is a scalar; no Prisma relation). */
export interface EddmOrderWithCreative extends EddmOrder {
  creative: MailCreative | null;
}

export async function attachCreative(order: EddmOrder): Promise<EddmOrderWithCreative> {
  const creative = order.creativeId
    ? await prisma.mailCreative.findFirst({
        where: { id: order.creativeId, workspaceId: order.workspaceId },
      })
    : null;
  return { ...order, creative };
}

export async function getEddmOrderWithCreative(
  workspaceId: string,
  id: string,
): Promise<EddmOrderWithCreative | null> {
  const order = await getEddmOrder(workspaceId, id);
  if (!order) return null;
  return attachCreative(order);
}

export async function listEddmOrders(workspaceId: string): Promise<EddmOrderWithCreative[]> {
  const orders = await prisma.eddmOrder.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
  });
  return Promise.all(orders.map(attachCreative));
}

export async function createEddmOrder(input: {
  workspaceId: string;
  name: string;
  mailhouse?: string | null;
  createdBy?: string | null;
}): Promise<EddmOrder> {
  const name = input.name.trim();
  if (!name) throw new Error("Order name is required.");
  if (name.length > 160) throw new Error("Order name is too long (max 160).");
  return prisma.eddmOrder.create({
    data: {
      workspaceId: input.workspaceId,
      name,
      zips: [],
      routes: [],
      mailhouse: input.mailhouse?.trim() || null,
      createdBy: input.createdBy ?? null,
    },
  });
}

function assertEditable(order: EddmOrder): void {
  if (order.status !== "draft" && order.status !== "briefed") {
    throw new Error(`Order is ${order.status} — fields are locked. Cancel or duplicate it to change.`);
  }
}

export async function updateEddmOrderFields(
  workspaceId: string,
  id: string,
  patch: { name?: string; mailhouse?: string | null; dropDate?: Date | null },
): Promise<EddmOrder> {
  const order = await getEddmOrder(workspaceId, id);
  if (!order) throw new Error("EDDM order not found");
  assertEditable(order);
  const data: Prisma.EddmOrderUpdateInput = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("Order name is required.");
    data.name = name.slice(0, 160);
  }
  if (patch.mailhouse !== undefined) data.mailhouse = patch.mailhouse?.trim() || null;
  if (patch.dropDate !== undefined) {
    if (patch.dropDate && Number.isNaN(patch.dropDate.getTime())) throw new Error("Invalid drop date.");
    data.dropDate = patch.dropDate;
  }
  return prisma.eddmOrder.update({ where: { id }, data });
}

/** Replace the route table (draft only — post-brief edits need a re-brief). */
export async function setEddmRoutes(
  workspaceId: string,
  id: string,
  routes: unknown,
  postageTier: EddmPostageTier = "retail",
): Promise<EddmOrder> {
  const order = await getEddmOrder(workspaceId, id);
  if (!order) throw new Error("EDDM order not found");
  if (order.status !== "draft") {
    throw new Error("Routes can only change while the order is a draft.");
  }
  const validation = validateEddmRoutes(routes, postageTier);
  if (!validation.ok) {
    throw new Error(`Route validation failed: ${validation.errors[0]}`);
  }
  const zips = [...new Set(coerceEddmRoutes(routes).filter((r) => r.selected !== false).map((r) => r.zip))];
  return prisma.eddmOrder.update({
    where: { id },
    data: {
      routes: coerceEddmRoutes(routes) as unknown as Prisma.InputJsonValue,
      zips: zips as unknown as Prisma.InputJsonValue,
      pieceCount: validation.pieceCount,
    },
  });
}

/**
 * Bind a Studio creative to the order. Format-track enforcement: only
 * `eddm`-track creatives qualify — a 4x6 postcard (addressed track) is
 * rejected because EDDM requires flats of at least 6.125" x 11.5".
 */
export async function setEddmCreative(
  workspaceId: string,
  orderId: string,
  creativeId: string,
): Promise<EddmOrder> {
  const order = await getEddmOrder(workspaceId, orderId);
  if (!order) throw new Error("EDDM order not found");
  assertEditable(order);
  const creative = await prisma.mailCreative.findFirst({
    where: { id: creativeId, workspaceId },
  });
  if (!creative) throw new Error("Creative not found");
  if (creative.formatTrack !== "eddm") {
    throw new Error(
      `Creative "${creative.name}" is on the "${creative.formatTrack}" format track — EDDM orders require an "eddm"-track flat (min 6.125" x 11.5"; a 4x6 postcard does not qualify).`,
    );
  }
  return prisma.eddmOrder.update({ where: { id: orderId }, data: { creativeId: creative.id } });
}

/** Compute and persist the estimate (draft/briefed). Returns the estimate. */
export async function saveEddmEstimate(
  workspaceId: string,
  id: string,
  input: { postageTier?: EddmPostageTier; printCentsPerPiece?: number },
): Promise<{ order: EddmOrder; estimate: EddmEstimate }> {
  const order = await getEddmOrder(workspaceId, id);
  if (!order) throw new Error("EDDM order not found");
  assertEditable(order);
  const routes = coerceEddmRoutes(order.routes);
  const validation = validateEddmRoutes(routes, input.postageTier ?? "retail");
  if (!validation.ok) {
    throw new Error(`Route validation failed: ${validation.errors[0]}`);
  }
  const estimate = estimateEddmCost({
    routes,
    postageTier: input.postageTier,
    printCentsPerPiece: input.printCentsPerPiece,
  });
  const updated = await prisma.eddmOrder.update({
    where: { id },
    data: {
      pieceCount: estimate.pieceCount,
      postageCents: estimate.postageCents,
      printCents: estimate.printCents,
      costCents: estimate.totalCents,
    },
  });
  return { order: updated, estimate };
}

// ---------------------------------------------------------------------------
// Attribution hook
// ---------------------------------------------------------------------------

export interface EddmDropAttribution {
  qrSlug: string;
  dropUrl: string;
}

/**
 * Attribution hook run when a drop completes entering "dropped".
 * Touches require an identified lead (lib/attribution/touches.ts), and EDDM
 * pieces are anonymous households at drop time — so the hook arms the
 * instrument instead of fabricating a touch:
 *   1. mint the per-drop QR slug if missing,
 *   2. return the slug + reserved pURL for the brief.
 * Scans/identifications later flow into the attribution ledger via the
 * per-drop slug when T1 wires scan routing.
 *
 * NOTE: EDDM lifecycle events cannot be written to FileChangeLog yet —
 * FileChangeAction is a closed DB enum with no eddm_* actions (extending it
 * requires a schema migration, owned by the coordinator). Until then the
 * drop is recorded on the order row itself (status, in-home window, slug).
 */
export async function recordEddmDropAttribution(input: {
  workspaceId: string;
  orderId: string;
  origin: string;
}): Promise<EddmDropAttribution> {
  const order = await getEddmOrder(input.workspaceId, input.orderId);
  if (!order) throw new Error("EDDM order not found");
  let qrSlug = order.qrSlug;
  if (!qrSlug) {
    qrSlug = await mintEddmQrSlug();
    await prisma.eddmOrder.update({ where: { id: order.id }, data: { qrSlug } });
  }
  return { qrSlug, dropUrl: eddmDropUrl(qrSlug, input.origin) };
}

// ---------------------------------------------------------------------------
// Status transition with side effects
// ---------------------------------------------------------------------------

export interface EddmTransitionInput {
  workspaceId: string;
  id: string;
  to: EddmStatus;
  /** Required when transitioning to "dropped" (defaults to existing). */
  dropDate?: Date;
  origin?: string;
  actorUserId?: string | null;
}

export async function applyEddmStatus(input: EddmTransitionInput): Promise<EddmOrder> {
  const order = await getEddmOrder(input.workspaceId, input.id);
  if (!order) throw new Error("EDDM order not found");
  assertEddmTransition(order.status, input.to);

  const data: Prisma.EddmOrderUpdateInput = { status: input.to };

  if (input.to === "briefed" && !order.briefPdfUrl) {
    throw new Error("Generate the mailhouse handoff brief before marking the order briefed.");
  }
  if (input.to === "at_mailhouse" && order.pieceCount <= 0) {
    throw new Error("Order has no pieces — set carrier routes first.");
  }
  if (input.to === "dropped") {
    const dropDate = input.dropDate ?? order.dropDate;
    if (!dropDate || Number.isNaN(dropDate.getTime())) {
      throw new Error("A drop date is required to mark the order dropped.");
    }
    data.dropDate = dropDate;
    if (!order.inHomeStart || !order.inHomeEnd) {
      const win = eddmInHomeWindow(dropDate);
      data.inHomeStart = win.start;
      data.inHomeEnd = win.end;
    }
  }

  const updated = await prisma.eddmOrder.update({ where: { id: order.id }, data });

  if (input.to === "dropped") {
    await recordEddmDropAttribution({
      workspaceId: input.workspaceId,
      orderId: order.id,
      origin: input.origin ?? "",
    });
  }
  // "cancelled" is recorded on the order row (status); FileChangeLog cannot
  // represent eddm_* actions until the FileChangeAction enum is extended
  // (schema change, owned by the coordinator).
  return (await getEddmOrder(input.workspaceId, order.id)) ?? updated;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Next allowed statuses for the timeline UI. */
export function eddmNextStatuses(from: string): EddmStatus[] {
  return EDDM_TRANSITIONS[from as EddmStatus] ?? [];
}
