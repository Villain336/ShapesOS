// ShapesOS — Phase 13 (twincore): the twin STATE SERVICE (server-only).
//
// Implements the contract signatures (siteSnapshot / listSites / siteDiff):
// it reads the site's layout objects, then derives each object's live state
// from the record it is bound to — per-location stock from the ledger
// (lib/ops/stock.ts stockByLocation), work orders + time logs, till
// sessions, dock bookings — plus KPIs, shipments and agent markers. The
// rules themselves are pure (lib/twin/derive.ts). Nothing here writes.
//
// Every read runs inside withWorkspaceScope (FORCE RLS) and filters by
// workspaceId; a site of another workspace is a TwinNotFoundError (404).

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { stockByLocation } from "@/lib/ops/stock";
import {
  AGENT_MARKER_WINDOW_MS,
  ACTIVE_BOOKING_STATUSES,
  ON_TIME_WINDOW_MS,
  UTILISATION_WINDOW_DAYS,
  agentMarkers,
  deriveDock,
  deriveEquipment,
  deriveKpis,
  deriveProductShelf,
  deriveRegister,
  deriveShipments,
  deriveStock,
  deriveWorkCenter,
  diffSnapshots,
  footprintCentre,
  locationSubtree,
  lowProducts,
  type AgentRunActivity,
  type BookingRow,
  type LocationNode,
  type SessionRow,
  type StockQty,
  type TimeLogRow,
  type WorkOrderRow,
} from "./derive";
import type {
  TwinBindingType,
  TwinObject,
  TwinObjectKind,
  TwinObjectState,
  TwinPatchOp,
  TwinRotation,
  TwinSiteKind,
  TwinSiteStatus,
  TwinSnapshot,
} from "./types";

type Tx = Prisma.TransactionClient;

export class TwinNotFoundError extends Error {
  readonly status = 404;
  constructor(siteId: string) {
    super(`Twin site "${siteId}" not found in workspace`);
    this.name = "TwinNotFoundError";
  }
}

/** Every object of the site with its derived state, plus KPIs, shipments and agent markers. Workspace-scoped (RLS). */
export async function siteSnapshot(workspaceId: string, siteId: string): Promise<TwinSnapshot> {
  return withWorkspaceScope(workspaceId, (tx) => siteSnapshotTx(tx, workspaceId, siteId));
}

/**
 * Phase 14 (approvals): who may see a site live. Editors (operators) see
 * drafts and published sites; every other member sees PUBLISHED sites only
 * — a draft is editor-only. PURE.
 */
export function canViewSite(status: TwinSiteStatus | string, canEdit: boolean): boolean {
  return canEdit || status === "published";
}

/**
 * Phase 14: the snapshot for a member — a draft is "not found" for a
 * non-editor (never revealed), exactly like a site of another workspace.
 */
export async function siteSnapshotFor(workspaceId: string, siteId: string, canEdit: boolean): Promise<TwinSnapshot> {
  const snap = await siteSnapshot(workspaceId, siteId);
  if (!canViewSite(snap.site.status, canEdit)) throw new TwinNotFoundError(siteId);
  return snap;
}

/**
 * Phase 14: the live stream's snapshot loader + per-tick access check for one
 * member (GET /api/twin/sites/[id]/live): still a member, and — unless an
 * editor — the site is still PUBLISHED, so a site moving back to draft ends
 * a viewer's stream (access-revoked).
 */
export function twinLiveAccess(input: {
  workspaceId: string;
  siteId: string;
  isMember: () => Promise<boolean>;
  isEditor: () => Promise<boolean>;
}): { snapshot: () => Promise<TwinSnapshot>; stillAllowed: () => Promise<boolean>; signal: () => Promise<string> } {
  const { workspaceId, siteId } = input;
  return {
    // Phase 17 (latency): the change signal — the stream skips the snapshot
    // while it does not move (lib/twin/signal.ts).
    signal: async () => (await import("./signal")).siteSignal(workspaceId, siteId).then((s) => s.version),
    snapshot: async () => siteSnapshotFor(workspaceId, siteId, await input.isEditor()),
    stillAllowed: async () => {
      if (!(await input.isMember())) return false;
      if (await input.isEditor()) return true;
      return canViewSite((await siteStatus(workspaceId, siteId)) ?? "gone", false);
    },
  };
}

/** Phase 14: the site's status (null when it is gone) — the live stream's per-tick access re-check. */
export async function siteStatus(workspaceId: string, siteId: string): Promise<TwinSiteStatus | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.opsSite.findFirst({ where: { id: siteId, workspaceId }, select: { status: true } }),
  );
  return row ? (row.status as TwinSiteStatus) : null;
}

/** Sites of the workspace for the list page (no derived state). */
export async function listSites(
  workspaceId: string,
): Promise<{ id: string; kind: TwinSnapshot["site"]["kind"]; status: TwinSnapshot["site"]["status"]; name: string; code: string; objectCount: number; updatedAt: string }[]> {
  return withWorkspaceScope(workspaceId, (tx) => listSitesTx(tx, workspaceId));
}

/** RFC 6902 ops turning `prev` into `next` (empty when equal). PURE — the rules live in lib/twin/derive.ts (diffSnapshots), importable client-side. */
export function siteDiff(prev: TwinSnapshot, next: TwinSnapshot): TwinPatchOp[] {
  return diffSnapshots(prev, next);
}

export async function listSitesTx(tx: Tx, workspaceId: string) {
  const sites = await tx.opsSite.findMany({
    where: { workspaceId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    include: { _count: { select: { objects: true } } },
    take: 200,
  });
  return sites.map((s) => ({
    id: s.id,
    kind: s.kind as TwinSiteKind,
    status: s.status as TwinSiteStatus,
    name: s.name,
    code: s.code,
    objectCount: s._count.objects,
    updatedAt: s.updatedAt.toISOString(),
  }));
}

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** The snapshot inside an existing workspace-scoped transaction (tools, the SSE loop, the alert sweep). */
export async function siteSnapshotTx(tx: Tx, workspaceId: string, siteId: string, now: Date = new Date()): Promise<TwinSnapshot> {
  const site = await tx.opsSite.findFirst({ where: { id: siteId, workspaceId } });
  if (!site) throw new TwinNotFoundError(siteId);
  const actor = { workspaceId, userId: "twin:state" };
  const objects = await tx.opsSiteObject.findMany({ where: { workspaceId, siteId }, orderBy: { id: "asc" } });

  const idsOf = (t: TwinBindingType) => [...new Set(objects.filter((o) => o.bindingType === t && o.bindingId).map((o) => o.bindingId!))];
  const wcIds = idsOf("work_center");
  const registerIds = idsOf("register");
  const productIds = idsOf("product");

  // --- the warehouse: locations, stock (ledger), low-stock thresholds ---
  const locations: LocationNode[] = (
    await tx.opsLocation.findMany({
      where: { workspaceId, warehouseId: site.warehouseId },
      select: { id: true, parentId: true, kind: true, code: true, path: true, name: true },
    })
  ).map((l) => ({ id: l.id, parentId: l.parentId, kind: l.kind, code: l.code, path: l.path }));
  const L = new Map(locations.map((l) => [l.id, l]));
  const stock = await stockByLocation(tx, actor, { warehouseId: site.warehouseId });
  const stockRows: StockQty[] = stock.map((r) => ({ productId: r.productId, locationId: r.locationId, qty: r.qty }));
  const rules = await tx.opsReorderRule.findMany({
    where: { workspaceId, warehouseId: site.warehouseId, active: true },
    select: { productId: true, minQty: true, receiveLocationId: true },
  });
  const watchedIds = [...new Set([...stockRows.map((r) => r.productId), ...rules.map((r) => r.productId), ...productIds])];
  const products = watchedIds.length
    ? await tx.opsProduct.findMany({
        where: { workspaceId, id: { in: watchedIds } },
        select: { id: true, name: true, sku: true, trackInventory: true, lowStockThreshold: true },
      })
    : [];
  const P = new Map(products.map((p) => [p.id, p]));
  const thresholds = new Map<string, number>();
  for (const p of products) if (p.trackInventory) thresholds.set(p.id, p.lowStockThreshold);
  for (const r of rules) if (P.get(r.productId)?.trackInventory) thresholds.set(r.productId, Math.max(thresholds.get(r.productId) ?? 0, r.minQty));
  const ruleLocations = rules.map((r) => ({ productId: r.productId, locationId: r.receiveLocationId }));
  const low = lowProducts(stockRows, { thresholds, ruleLocations });

  // --- dock bookings: active, or finished inside the on-time KPI window ---
  const bookingRows = await tx.opsDockBooking.findMany({
    where: {
      workspaceId,
      siteId,
      OR: [
        { status: { in: [...ACTIVE_BOOKING_STATUSES] } },
        { status: "done", doneAt: { gte: new Date(now.getTime() - ON_TIME_WINDOW_MS) } },
      ],
    },
    include: {
      purchaseOrder: { select: { status: true, sentAt: true, receivedAt: true } },
      order: { select: { status: true, paidAt: true, createdAt: true } },
      transfer: { select: { status: true, doneAt: true, createdAt: true } },
    },
    orderBy: [{ eta: "asc" }, { id: "asc" }],
    take: 1000,
  });
  const bookings: BookingRow[] = bookingRows.map((b) => ({ ...b, status: b.status, direction: b.direction }));

  // --- work centres: open work orders, 7-day time logs ---
  const workCenters = wcIds.length ? await tx.opsWorkCenter.findMany({ where: { workspaceId, id: { in: wcIds } } }) : [];
  const WC = new Map(workCenters.map((w) => [w.id, w]));
  const wos: WorkOrderRow[] = wcIds.length
    ? (
        await tx.opsWorkOrder.findMany({
          where: { workspaceId, workCenterId: { in: wcIds }, status: { in: ["pending", "in_progress", "paused"] } },
          include: { mo: { select: { id: true, number: true, status: true, plannedStart: true } } },
        })
      ).map((w) => ({ id: w.id, workCenterId: w.workCenterId, name: w.name, sequence: w.sequence, status: w.status, runningSince: w.runningSince, mo: w.mo }))
    : [];
  // A pending step is ready only when it is its MO's lowest open step.
  if (wos.some((w) => w.status === "pending")) {
    const openSteps = await tx.opsWorkOrder.findMany({
      where: { workspaceId, moId: { in: [...new Set(wos.map((w) => w.mo.id))] }, status: { in: ["pending", "in_progress", "paused"] } },
      select: { moId: true, sequence: true },
    });
    const first = new Map<string, number>();
    for (const s of openSteps) first.set(s.moId, Math.min(first.get(s.moId) ?? Infinity, s.sequence));
    for (const w of wos) if (w.status === "pending") w.ready = first.get(w.mo.id) === w.sequence;
  }
  const windowStart = new Date(now.getTime() - UTILISATION_WINDOW_DAYS * 86_400_000);
  const logs: TimeLogRow[] = wcIds.length
    ? (
        await tx.opsWorkTimeLog.findMany({
          where: { workspaceId, endedAt: { gt: windowStart }, workOrder: { workCenterId: { in: wcIds } } },
          select: { startedAt: true, endedAt: true, seconds: true, workOrder: { select: { workCenterId: true } } },
          take: 20_000,
        })
      ).map((l) => ({ workCenterId: l.workOrder.workCenterId, startedAt: l.startedAt, endedAt: l.endedAt, seconds: l.seconds }))
    : [];

  // --- registers: open/closing session + its sales; sales today ---
  const registers = registerIds.length ? await tx.opsPosRegister.findMany({ where: { workspaceId, id: { in: registerIds } } }) : [];
  const R = new Map(registers.map((r) => [r.id, r]));
  const sessions = registerIds.length
    ? await tx.opsPosSession.findMany({
        where: { workspaceId, registerId: { in: registerIds }, status: { in: ["open", "closing"] } },
        select: { id: true, registerId: true, number: true, status: true, openedAt: true },
      })
    : [];
  const sessionSales = new Map<string, number>();
  if (sessions.length) {
    const sums = await tx.opsOrder.groupBy({
      by: ["posSessionId"],
      where: { workspaceId, posSessionId: { in: sessions.map((s) => s.id) }, status: { not: "cancelled" } },
      _sum: { totalCents: true },
    });
    for (const s of sums) if (s.posSessionId) sessionSales.set(s.posSessionId, s._sum.totalCents ?? 0);
  }
  let salesToday = { cents: 0, count: 0 };
  if (site.kind === "store" && registerIds.length) {
    const agg = await tx.opsOrder.aggregate({
      where: { workspaceId, source: "pos", status: { not: "cancelled" }, createdAt: { gte: startOfUtcDay(now) }, posSession: { registerId: { in: registerIds } } },
      _sum: { totalCents: true },
      _count: { _all: true },
    });
    salesToday = { cents: agg._sum.totalCents ?? 0, count: agg._count._all };
  }

  // --- assemble objects ---
  const dockObjectByLocation = new Map<string, string>();
  const objectByLocation = new Map<string, (typeof objects)[number]>();
  for (const o of objects) {
    if (o.bindingType !== "location" || !o.bindingId) continue;
    if (!objectByLocation.has(o.bindingId)) objectByLocation.set(o.bindingId, o);
    if (o.kind === "dock_door" && !dockObjectByLocation.has(o.bindingId)) dockObjectByLocation.set(o.bindingId, o.id);
  }

  const wcDerived: Array<{ status: string; utilisationPct: number }> = [];
  const regDerived: Array<{ status: string }> = [];
  const twinObjects: TwinObject[] = objects.map((o) => {
    const kind = o.kind as TwinObjectKind;
    const footprint = { x: o.x, z: o.z, w: o.w, d: o.d, h: o.h, rotation: o.rotation as TwinRotation };
    let bindingLabel: string | null = null;
    let broken = false;
    let state: TwinObjectState = { kind } as TwinObjectState;
    let pill: string | null = null;
    let alert: TwinObject["alert"] = null;
    const bid = o.bindingId;
    const type = o.bindingType as TwinBindingType | null;

    if (type === "location" && bid) {
      const loc = L.get(bid);
      if (!loc) broken = true;
      else bindingLabel = loc.path;
    } else if (type === "work_center" && bid) {
      const wc = WC.get(bid);
      if (!wc) broken = true;
      else bindingLabel = `${wc.code} · ${wc.name}`;
    } else if (type === "register" && bid) {
      const r = R.get(bid);
      if (!r) broken = true;
      else bindingLabel = r.name;
    } else if (type === "product" && bid) {
      const p = P.get(bid);
      if (!p) broken = true;
      else bindingLabel = `${p.sku} · ${p.name}`;
    }

    if (kind === "dock_door") {
      const d = deriveDock(bid && !broken ? bookings.filter((b) => b.dockLocationId === bid) : [], now);
      [state, pill, alert] = [d.state, d.pill, d.alert];
    } else if (kind === "rack" || kind === "bin_zone" || kind === "shelf") {
      const d =
        type === "product" && bid && !broken
          ? deriveProductShelf(bid, stockRows, low)
          : deriveStock(kind, bid && !broken && type === "location" ? locationSubtree(bid, locations) : new Set<string>(), stockRows, low, ruleLocations);
      [state, pill, alert] = [d.state, d.pill, d.alert];
      if (!bid || broken) alert = null;
    } else if (kind === "work_center") {
      const wc = bid && !broken ? WC.get(bid) : undefined;
      const d = deriveWorkCenter(wc ? wos.filter((w) => w.workCenterId === wc.id) : [], wc?.capacity ?? 1, wc ? logs.filter((l) => l.workCenterId === wc.id) : [], now);
      [state, pill, alert] = [d.state, d.pill, d.alert];
      if (wc) wcDerived.push({ status: d.state.status, utilisationPct: d.state.utilisationPct });
    } else if (kind === "register") {
      const r = bid && !broken ? R.get(bid) : undefined;
      const s = r ? sessions.find((x) => x.registerId === r.id) : undefined;
      const session: SessionRow | null = s ? { id: s.id, number: s.number, status: s.status, openedAt: s.openedAt } : null;
      const d = deriveRegister(session, session ? sessionSales.get(session.id) ?? 0 : 0, now);
      [state, pill, alert] = [d.state, d.pill, d.alert];
      if (r) regDerived.push({ status: d.state.status });
    } else if (kind === "equipment") {
      const taskLoc = o.taskLocationId ? L.get(o.taskLocationId) : undefined;
      const target = o.taskLocationId ? objectByLocation.get(o.taskLocationId) : undefined;
      const d = deriveEquipment(o, o.taskLocationId ? { label: target?.label ?? taskLoc?.path ?? null, centre: target ? footprintCentre(target) : null } : null);
      [state, pill] = [d.state, d.pill];
    }

    return {
      id: o.id,
      kind,
      label: o.label,
      footprint,
      binding: type && bid ? { type, id: bid, label: bindingLabel } : null,
      bindingBroken: broken,
      state,
      pill: broken ? "Unbound" : pill,
      alert,
    };
  });

  const kpis = deriveKpis({ kind: site.kind as TwinSiteKind, stockRows, bookings, workCenters: wcDerived, registers: regDerived, salesToday, now });
  const shipments = deriveShipments(bookings, (loc) => dockObjectByLocation.get(loc) ?? null, now);
  const agents = agentMarkers(await recentAgentActivity(tx, workspaceId, now), twinObjects);

  return {
    site: {
      id: site.id,
      kind: site.kind as TwinSiteKind,
      status: site.status as TwinSiteStatus,
      name: site.name,
      code: site.code,
      gridW: site.gridW,
      gridD: site.gridD,
      warehouseId: site.warehouseId,
    },
    objects: twinObjects,
    kpis,
    shipments,
    agents,
    generatedAt: now.toISOString(),
  };
}

/**
 * Runs that are working now (queued / running), or finished within the
 * window while waiting on a person's OK, with the text of their recent run
 * events (summaries + payloads) — what agentMarkers() matches ids against.
 */
export async function recentAgentActivity(tx: Tx, workspaceId: string, now: Date): Promise<AgentRunActivity[]> {
  const since = new Date(now.getTime() - AGENT_MARKER_WINDOW_MS);
  const runs = await tx.agentRun.findMany({
    where: {
      workspaceId,
      OR: [{ status: { in: ["queued", "running"] } }, { status: "succeeded", endedAt: { gte: since } }],
    },
    select: { id: true, agentKey: true, status: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  if (!runs.length) return [];
  const events = await tx.agentRunEvent.findMany({
    where: { workspaceId, runId: { in: runs.map((r) => r.id) }, createdAt: { gte: since }, type: { in: ["agui", "gate", "note", "text"] } },
    select: { runId: true, seq: true, type: true, summary: true, payload: true },
    orderBy: [{ runId: "asc" }, { seq: "asc" }],
    take: 2000,
  });
  return runs.flatMap((r) => {
    const mine = events.filter((e) => e.runId === r.id);
    if (!mine.length) return [];
    const last = mine.filter((e) => e.type !== "text").at(-1);
    const waiting = Boolean(last && last.type === "gate" && /^Waiting for your OK/.test(last.summary));
    if (r.status === "succeeded" && !waiting) return [];
    const haystack = mine.map((e) => `${e.summary}\n${e.payload ? JSON.stringify(e.payload) : ""}`).join("\n");
    return [{ runId: r.id, agentKey: r.agentKey, status: r.status, waiting, haystack }];
  });
}
