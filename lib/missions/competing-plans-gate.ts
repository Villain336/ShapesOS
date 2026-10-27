// ShapesOS - the server-side gate for competing plans. OFF unless BOTH are set
// by the operator: COMPETING_PLANS_ENABLED=1 and COMPETING_PLANS_CAP_MICRO_USD
// (a positive integer: the most one run may cost at the conservative ceiling).
// Pure; no prisma. Enabling is an owner decision about real spend.

export interface CompetingPlansGate {
  enabled: boolean;
  capMicroUsd: number | null;
  reason: string;
}

export function competingPlansGate(env: Record<string, string | undefined> = process.env): CompetingPlansGate {
  if (env.COMPETING_PLANS_ENABLED !== "1") {
    return { enabled: false, capMicroUsd: null, reason: "Off. Running competing plans calls a paid model and needs the owner's approval and a spend limit first." };
  }
  const raw = env.COMPETING_PLANS_CAP_MICRO_USD;
  const cap = raw && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    return { enabled: false, capMicroUsd: null, reason: "Off. A positive COMPETING_PLANS_CAP_MICRO_USD spend ceiling is required." };
  }
  return { enabled: true, capMicroUsd: cap, reason: "On." };
}
