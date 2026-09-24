// Marketr — call tracking (R5): the call_minutes meter.
//
// Usage *dimension* for plan limits and reporting (MASTER-PLAN.md C4 lists
// call minutes as a meter): whole minutes of tracked call time per
// workspace, billed per minute started (ceil of durationSec / 60) — the same
// rule Twilio uses, so pass-through cost reconciles with the provider
// invoice. Additive, read-only, zero billing behavior change: this module
// never calls meter() and never creates a ledger charge. Documented in
// lib/metering/SEAM.md ("call_minutes").

import { prisma } from "@/lib/prisma";

/** Whole call minutes for a workspace (sum of ceil(durationSec/60)). */
export async function getCallMinutes(workspaceId: string): Promise<number> {
  const rows = await prisma.call.findMany({
    where: { workspaceId, status: { in: ["completed", "voicemail"] } },
    select: { durationSec: true },
  });
  return rows.reduce((acc, r) => acc + Math.ceil(r.durationSec / 60), 0);
}

/** Call minutes per tracking number (for the calls dashboard). */
export async function getCallMinutesByNumber(
  workspaceId: string,
): Promise<Record<string, number>> {
  const rows = await prisma.call.findMany({
    where: { workspaceId, status: { in: ["completed", "voicemail"] } },
    select: { numberId: true, durationSec: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.numberId] = (out[r.numberId] ?? 0) + Math.ceil(r.durationSec / 60);
  }
  return out;
}
