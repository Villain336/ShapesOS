// ShapesOS — Phase 17 (latency, A7): the twin's cheap CHANGE SIGNAL.
//
// A twin snapshot (lib/twin/state.ts siteSnapshotTx) reads ~15 tables and
// derives every object's state — the live stream re-ran it every 4 s per
// open viewer, and the polling fallback fetched it whole. The signal is one
// SQL statement over the SAME source tables: per table a row count and the
// newest change time (updated_at, or created_at / ended_at for append-only
// tables), all scoped to the workspace under RLS, hashed into a version.
//
//   * any insert, update or delete of a record the snapshot reads changes
//     the version (a count or a max timestamp moves);
//   * the snapshot also derives TIME-based states (a dock booking turning
//     late, the 15-minute agent-marker window, utilisation windows), so the
//     version also carries the minute: it changes at least once a minute.
//
// Used by GET /api/twin/sites/[id]/state (ETag / If-None-Match → 304, and
// ?signal=1 → just { version }), by the polling fallback in useTwinLive
// (fetch the full snapshot only when the version moved) and by the live
// stream (skip the snapshot + diff when nothing moved). Server-only.

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { AGENT_MARKER_WINDOW_MS } from "./derive";
import type { TwinSiteStatus } from "./types";

type Tx = Prisma.TransactionClient;

/** The version moves at least this often (time-derived states). */
export const TWIN_SIGNAL_BUCKET_MS = 60_000;

export interface TwinSignal {
  version: string;
  /** The site's status (null = gone) — the access check needs it anyway. */
  status: TwinSiteStatus | null;
}

/** The raw per-table facts behind a version (exported for tests). */
export async function twinSignalFacts(tx: Tx, workspaceId: string, siteId: string, now: Date): Promise<Record<string, unknown> | null> {
  const since = new Date(now.getTime() - AGENT_MARKER_WINDOW_MS);
  const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
    SELECT
      s.status::text AS status, s.updated_at AS site_at, s.warehouse_id AS warehouse_id,
      (SELECT row(count(*), max(updated_at))::text FROM ops_site_objects  WHERE workspace_id = ${workspaceId} AND site_id = ${siteId}) AS objects,
      (SELECT row(count(*), max(updated_at))::text FROM ops_locations     WHERE workspace_id = ${workspaceId} AND warehouse_id = s.warehouse_id) AS locations,
      (SELECT row(count(*), max(created_at))::text FROM ops_inventory_txns WHERE workspace_id = ${workspaceId}) AS stock,
      (SELECT row(count(*), max(updated_at))::text FROM ops_reorder_rules WHERE workspace_id = ${workspaceId}) AS rules,
      (SELECT row(count(*), max(updated_at))::text FROM ops_products      WHERE workspace_id = ${workspaceId}) AS products,
      (SELECT row(count(*), max(updated_at))::text FROM ops_dock_bookings WHERE workspace_id = ${workspaceId} AND site_id = ${siteId}) AS bookings,
      (SELECT row(count(*), max(updated_at))::text FROM ops_purchase_orders WHERE workspace_id = ${workspaceId}) AS purchase_orders,
      (SELECT row(count(*), max(updated_at))::text FROM ops_orders        WHERE workspace_id = ${workspaceId}) AS orders,
      (SELECT row(count(*), max(updated_at))::text FROM ops_transfers     WHERE workspace_id = ${workspaceId}) AS transfers,
      (SELECT row(count(*), max(updated_at))::text FROM ops_work_centers  WHERE workspace_id = ${workspaceId}) AS work_centers,
      (SELECT row(count(*), max(updated_at))::text FROM ops_work_orders   WHERE workspace_id = ${workspaceId}) AS work_orders,
      (SELECT row(count(*), max(updated_at))::text FROM ops_manufacturing_orders WHERE workspace_id = ${workspaceId}) AS mos,
      (SELECT row(count(*), max(created_at), max(ended_at))::text FROM ops_work_time_logs WHERE workspace_id = ${workspaceId}) AS time_logs,
      (SELECT row(count(*), max(updated_at))::text FROM ops_pos_registers WHERE workspace_id = ${workspaceId}) AS registers,
      (SELECT row(count(*), max(updated_at))::text FROM ops_pos_sessions  WHERE workspace_id = ${workspaceId}) AS sessions,
      (SELECT row(count(*), count(*) FILTER (WHERE status IN ('queued', 'running')), max(created_at), max(ended_at))::text
         FROM agent_runs WHERE workspace_id = ${workspaceId}) AS runs,
      (SELECT row(count(*), max(created_at))::text FROM agent_run_events WHERE workspace_id = ${workspaceId} AND created_at >= ${since}) AS run_events
    FROM ops_sites s
    WHERE s.workspace_id = ${workspaceId} AND s.id = ${siteId}`;
  return rows[0] ?? null;
}

/** The version for a set of facts at a time (PURE). */
export function twinVersion(facts: Record<string, unknown> | null, now: Date): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(facts ?? { gone: true }, (_k, v) => (v instanceof Date ? v.toISOString() : typeof v === "bigint" ? v.toString() : v)));
  h.update(`|${Math.floor(now.getTime() / TWIN_SIGNAL_BUCKET_MS)}`);
  return h.digest("hex").slice(0, 32);
}

export async function siteSignalTx(tx: Tx, workspaceId: string, siteId: string, now: Date = new Date()): Promise<TwinSignal> {
  const facts = await twinSignalFacts(tx, workspaceId, siteId, now);
  return { version: twinVersion(facts, now), status: facts ? (String(facts.status) as TwinSiteStatus) : null };
}

/** The site's change signal (RLS-scoped; a site of another workspace reads as gone). */
export async function siteSignal(workspaceId: string, siteId: string, now: Date = new Date()): Promise<TwinSignal> {
  return withWorkspaceScope(workspaceId, (tx) => siteSignalTx(tx, workspaceId, siteId, now));
}

/** The ETag a version is sent as. */
export const twinEtag = (version: string) => `"twin-${version}"`;

/** Does an If-None-Match header carry this version? */
export function etagMatches(ifNoneMatch: string | null, version: string): boolean {
  if (!ifNoneMatch) return false;
  const want = twinEtag(version);
  return ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === want);
}
