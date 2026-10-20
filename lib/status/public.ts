// ShapesOS — the public status snapshot (beta readiness, WS=legal).
//
// One function the /status page and GET /api/status both call: live signals
// → derived components (with operator overrides) + the incident log, with
// operator ids stripped. Memoised per process for CACHE_SECONDS so a burst
// of public hits costs one readiness probe and two small queries.

import { collectLiveSignals } from "./live";
import { deriveComponents, overallStatus, type ComponentState, type ComponentStatus, type LiveSignals } from "./derive";
import { listComponentOverrides, listIncidents, toPublic, type PublicIncident } from "./store";

export const CACHE_SECONDS = 15;

export interface StatusSnapshot {
  overall: ComponentState;
  components: ComponentStatus[];
  incidents: { open: PublicIncident[]; recent: PublicIncident[] };
  generatedAt: string;
  cacheSeconds: number;
}

let memo: { at: number; snapshot: StatusSnapshot } | null = null;

export async function buildStatusSnapshot(now = new Date(), signals: () => Promise<LiveSignals> = () => collectLiveSignals(now)): Promise<StatusSnapshot> {
  const [live, overrides, incidents] = await Promise.all([signals(), listComponentOverrides(), listIncidents(now)]);
  const components = deriveComponents(live, overrides);
  return {
    overall: overallStatus(components),
    components,
    incidents: { open: incidents.open.map(toPublic), recent: incidents.recent.map(toPublic) },
    generatedAt: now.toISOString(),
    cacheSeconds: CACHE_SECONDS,
  };
}

/** The snapshot, memoised for CACHE_SECONDS unless `fresh`. */
export async function statusSnapshot(opts: { now?: Date; fresh?: boolean } = {}): Promise<StatusSnapshot> {
  const now = opts.now ?? new Date();
  if (!opts.fresh && memo && now.getTime() - memo.at < CACHE_SECONDS * 1000) return memo.snapshot;
  const snapshot = await buildStatusSnapshot(now);
  memo = { at: now.getTime(), snapshot };
  return snapshot;
}

/** Operators' writes call this so the next public read is current. */
export function invalidateStatusSnapshot(): void {
  memo = null;
}
