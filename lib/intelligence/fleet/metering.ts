// Marketr — Phase 10 M4: data-spend metering bridge.
//
// Spec §M4: DataForSEO Business Data spend ($0.012–$0.05/task) routes through
// M6's circuit breaker via `recordApiMeter(workspaceId, vendor, meter,
// quantity, costUsd)` — implemented at lib/intelligence/providers/meter.ts.
//
// KIND MAPPING (documented, open): M6's ApiMeterKind (TS + Prisma enum) has no
// review-pull/business-data member, and adding one needs a Prisma migration —
// which Phase 10 agents must not write. The fleet therefore records
// DataForSEO Business Data review pulls under "serp_call", the codebase's
// generic paid-call bucket (already used loosely for newsapi/GSC calls),
// with vendor="dataforseo" carrying the real identity so the cost dashboard
// still attributes the spend correctly. If the M6 owner lands a dedicated
// kind, update FLEET_METER_KIND below.

import {
  recordApiMeter,
  type ApiMeterKind,
} from "@/lib/intelligence/providers/meter";

export interface FleetSpend {
  workspaceId: string;
  vendor: string;
  /** Fleet-local meter label, e.g. "review_pull" (kept for callers; mapped
   *  onto an M6 ApiMeterKind at write time — see note above). */
  meter: string;
  quantity: number;
  costUsd: number;
}

/** Fleet-local label → M6 ApiMeterKind. Only "review_pull" is produced by
 *  the fleet today; unknown labels fall back to the generic paid-call
 *  bucket rather than failing the job. */
function toApiMeterKind(label: string): ApiMeterKind {
  if (label === "review_pull") return "serp_call"; // see mapping note above
  return "serp_call";
}

/** Record licensed data spend. Never throws — metering must not fail the
 *  fleet job; a missed meter entry is a reporting gap, not a correctness bug. */
export async function recordFleetSpend(spend: FleetSpend): Promise<void> {
  try {
    await recordApiMeter(
      spend.workspaceId,
      spend.vendor,
      toApiMeterKind(spend.meter),
      spend.quantity,
      spend.costUsd,
    );
  } catch {
    // no-op: metering is best-effort
  }
}
