// ShapesOS — Phase 13 (twincore): the twin ALERT sweep (server-only).
//
// /api/cron/twin-alerts runs it every 5 minutes. For each site it takes the
// same snapshot the twin draws (lib/twin/state.ts) and raises every object
// alert (dock overdue, bin low, machine stopped while late, register left
// open) ONCE per condition: the dedup key names the record behind it
// (lib/twin/derive.ts alertCandidates), the editors' in-app notification is
// keyed on it (unique per recipient), and the alert-hub event is emitted
// only the first time — so a condition that persists for hours alerts once,
// and a new truck / session / work order on the same object alerts anew.
// Never throws per site: one broken site doesn't stop the sweep.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { emitAlert } from "@/lib/alerts/evaluate";
import { notifyTwinAlert } from "@/lib/notifications/producers";
import { siteSnapshotTx } from "./state";
import { alertCandidates, type TwinAlertCandidate } from "./derive";
import type { TwinSnapshot } from "./types";

export interface TwinAlertSweepResult {
  workspaceId: string;
  sites: number;
  raised: number;
  alreadyRaised: number;
  errors: string[];
}

export interface TwinAlertDeps {
  snapshots: (workspaceId: string) => Promise<TwinSnapshot[]>;
  seen: (workspaceId: string, dedupKey: string) => Promise<boolean>;
  notify: typeof notifyTwinAlert;
  emit: typeof emitAlert;
}

/** Workspaces that have at least one twin site (sites are FORCE RLS, so each workspace is asked under its own scope). */
export async function workspacesWithSites(): Promise<string[]> {
  const ids = (await prisma.workspace.findMany({ select: { id: true }, take: 10_000 })).map((w) => w.id);
  const out: string[] = [];
  for (const id of ids) {
    if (await withWorkspaceScope(id, (tx) => tx.opsSite.count({ where: { workspaceId: id } }))) out.push(id);
  }
  return out;
}

export const defaultTwinAlertDeps: TwinAlertDeps = {
  snapshots: (workspaceId) =>
    withWorkspaceScope(workspaceId, async (tx) => {
      const sites = await tx.opsSite.findMany({ where: { workspaceId }, select: { id: true }, take: 200 });
      const out: TwinSnapshot[] = [];
      for (const s of sites) out.push(await siteSnapshotTx(tx, workspaceId, s.id));
      return out;
    }),
  // The notification table holds the "already raised" memory (no RLS on it; keyed per recipient).
  seen: async (workspaceId, dedupKey) => Boolean(await prisma.notification.findFirst({ where: { workspaceId, dedupKey }, select: { id: true } })),
  notify: notifyTwinAlert,
  emit: emitAlert,
};

export async function sweepTwinAlerts(workspaceId: string, deps: TwinAlertDeps = defaultTwinAlertDeps): Promise<TwinAlertSweepResult> {
  const result: TwinAlertSweepResult = { workspaceId, sites: 0, raised: 0, alreadyRaised: 0, errors: [] };
  let snaps: TwinSnapshot[];
  try {
    snaps = await deps.snapshots(workspaceId);
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message.slice(0, 200) : "snapshot failed");
    return result;
  }
  result.sites = snaps.length;
  for (const snap of snaps) {
    for (const c of alertCandidates(snap)) {
      try {
        if (await deps.seen(workspaceId, c.dedupKey)) {
          result.alreadyRaised++;
          continue;
        }
        await raise(workspaceId, snap, c, deps);
        result.raised++;
      } catch (e) {
        result.errors.push(`${c.objectId}: ${e instanceof Error ? e.message.slice(0, 200) : "failed"}`);
      }
    }
  }
  return result;
}

async function raise(workspaceId: string, snap: TwinSnapshot, c: TwinAlertCandidate, deps: TwinAlertDeps) {
  const link = `/dashboard/ops/twin/${encodeURIComponent(snap.site.id)}?object=${encodeURIComponent(c.objectId)}`;
  await deps.notify({ workspaceId, siteId: snap.site.id, siteName: snap.site.name, objectId: c.objectId, objectLabel: c.label, message: c.message, dedupKey: c.dedupKey });
  await deps.emit({
    workspaceId,
    trigger: c.trigger,
    severity: c.key === "bin_low" ? "info" : "warn",
    title: `${snap.site.name} · ${c.label}`,
    body: c.message,
    link,
    dedupKey: c.dedupKey,
  });
}
