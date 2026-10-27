// ShapesOS - the gate for competing plans: ALWAYS OFF in this change.
//
// There is deliberately no environment flag that turns it on. A flag plus an
// operator cap is not the owner's payment approval and would not pass through the
// existing budget/permission gates, so it would be an unmetered bypass waiting to
// be switched on. Enabling needs, at minimum (none of which exist yet):
//   1. the owner's explicit approval of real spend and a per-run price limit,
//      recorded where the existing budget gates read it;
//   2. provider usage metering for the calls, debited through those gates;
//   3. candidate persistence + revision-bound adoption with approval separation.
// Pure; no prisma.

export interface CompetingPlansGate {
  enabled: false;
  reason: string;
  missing: readonly string[];
}

export const COMPETING_PLANS_MISSING: readonly string[] = Object.freeze([
  "the owner's approval of real spend and a per-run price limit, recorded in the existing budget gates",
  "usage metering for the model calls through those gates",
  "stored candidates with revision-bound adoption and a separate approval",
]);

export function competingPlansGate(): CompetingPlansGate {
  return {
    enabled: false,
    reason: "Off. Running competing plans calls a paid model, and the approval, metering and adoption steps it needs are not built yet.",
    missing: COMPETING_PLANS_MISSING,
  };
}
