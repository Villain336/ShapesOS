// Marketr — /api/flywheel/dsp/stores
// Singleton in-memory stores backing the v1 F5 routes until the coordinator
// merges prisma/fragments/phase7-dsp.prisma and provisions SQL stores. The
// memory stores implement the same interfaces, so the route layer does not
// change when the backing store does.
//
// (Not a route: no HTTP exports.)

import {
  createMemoryDspAdapterStore,
  createMemoryFeeScheduleStore,
  createMemoryMarginLedgerStore,
  createMemoryDspCapStore,
  createMemoryDspAuditStore,
  seedAdapters,
} from "@/lib/flywheel/dsp";

const g = globalThis as unknown as Record<string, unknown>;

function singleton<T>(key: string, make: () => T): T {
  if (!g[key]) g[key] = make();
  return g[key] as T;
}

export const dspAdapterStore = () => singleton("f5-adapter-store", createMemoryDspAdapterStore);
export const feeScheduleStore = () => singleton("f5-fee-store", createMemoryFeeScheduleStore);
export const marginLedgerStore = () => singleton("f5-ledger-store", createMemoryMarginLedgerStore);
export const dspCapStore = () => singleton("f5-cap-store", createMemoryDspCapStore);
export const dspAuditStore = () => singleton("f5-audit-store", createMemoryDspAuditStore);

/** Ensure the four adapters exist for the workspace (default: no seat). */
export async function ensureAdapters(workspaceId: string) {
  const store = dspAdapterStore();
  for (const { dsp } of seedAdapters(workspaceId)) {
    await store.upsert(workspaceId, dsp);
  }
  return store.list(workspaceId);
}
