// ShapesOS — server-side plan entitlement checks (Phase 4a).
// The pure table lives in ./entitlements.ts (client-safe); these helpers read
// a workspace's plan (workspaces.plan — not an RLS table) and enforce it.

import type { Plan, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  EntitlementError,
  featureUpgradeMessage,
  limitUpgradeMessage,
  planHasFeature,
  planLimit,
  type Feature,
  type LimitKey,
} from "./entitlements";

export { EntitlementError, entitlementDenied } from "./entitlements";

export type PlanLookup = (workspaceId: string) => Promise<Plan | string | null>;

export const planOf: PlanLookup = async (workspaceId) => {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
  return ws?.plan ?? null;
};

/**
 * Does this workspace's plan include `feature`? The seam other workstreams
 * call (e.g. SCIM: `await hasEntitlement(workspaceId, "scim")`).
 * A missing workspace is false.
 */
export async function hasEntitlement(
  workspaceId: string,
  feature: Feature,
  lookup: PlanLookup = planOf,
): Promise<boolean> {
  return planHasFeature(await lookup(workspaceId), feature);
}

/** Throws EntitlementError (403, upgrade message) when the plan lacks `feature`. */
export async function requireEntitlement(
  workspaceId: string,
  feature: Feature,
  lookup: PlanLookup = planOf,
): Promise<void> {
  if (!(await hasEntitlement(workspaceId, feature, lookup))) {
    throw new EntitlementError(featureUpgradeMessage(feature), feature);
  }
}

/**
 * Throws EntitlementError when `used` already reaches the plan's `limit`.
 * Call it before creating the next seat/project/workspace.
 */
export async function requireWithinLimit(
  workspaceId: string,
  limit: LimitKey,
  used: number,
  lookup: PlanLookup = planOf,
): Promise<void> {
  const plan = await lookup(workspaceId);
  const max = planLimit(plan, limit);
  if (max !== null && used >= max) {
    throw new EntitlementError(limitUpgradeMessage(limit, max), limit);
  }
}

// ---------------------------------------------------------------------------
// Inside a transaction (Phase 15.3: digital_twin / payroll / pos gates)
// ---------------------------------------------------------------------------

/** The minimal transaction surface the Tx gates need (workspaces is not an RLS table). */
export type PlanTx = Pick<Prisma.TransactionClient, "workspace">;

export const planOfTx = (tx: PlanTx): PlanLookup => async (workspaceId) =>
  (await tx.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } }))?.plan ?? null;

/**
 * requireEntitlement for code that already runs in a workspace transaction
 * (the ops DocType service, the twin sample site): reads the plan through
 * the same transaction. Throws EntitlementError (403, upgrade message).
 */
export async function requireEntitlementTx(tx: PlanTx, workspaceId: string, feature: Feature): Promise<void> {
  await requireEntitlement(workspaceId, feature, planOfTx(tx));
}

/** requireWithinLimit through a transaction (e.g. twin sites counted in the same tx). */
export async function requireWithinLimitTx(tx: PlanTx, workspaceId: string, limit: LimitKey, used: number): Promise<void> {
  await requireWithinLimit(workspaceId, limit, used, planOfTx(tx));
}

// ---------------------------------------------------------------------------
// Usage counters for the numeric limits
// ---------------------------------------------------------------------------

/**
 * Seats in use: every member row (claimed or a pending invite — an invite
 * reserves its seat) plus a legacy owner without a member row.
 */
export async function seatsUsed(workspaceId: string): Promise<number> {
  const [members, ws] = await Promise.all([
    prisma.workspaceMember.findMany({ where: { workspaceId }, select: { userId: true } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ownerUserId: true } }),
  ]);
  const ownerHasRow = ws?.ownerUserId ? members.some((m) => m.userId === ws.ownerUserId) : true;
  return members.length + (ownerHasRow ? 0 : 1);
}

/** SEO projects in the workspace. */
export async function projectsUsed(workspaceId: string): Promise<number> {
  return prisma.project.count({ where: { workspaceId } });
}

/**
 * May this user own one more workspace? The allowance is the most generous
 * plan among the workspaces they already own (an agency owner can open client
 * workspaces; someone on Starter can't multiply workspaces). Owning none
 * always allows the first. Returns null when allowed, else the 403 error.
 */
export async function workspaceCreationDenial(userId: string): Promise<EntitlementError | null> {
  const owned = await prisma.workspace.findMany({ where: { ownerUserId: userId }, select: { plan: true } });
  return workspaceCreationDenialFor(owned.map((w) => w.plan));
}

/** Pure core of workspaceCreationDenial (exported for tests). */
export function workspaceCreationDenialFor(ownedPlans: Array<Plan | string>): EntitlementError | null {
  if (ownedPlans.length === 0) return null;
  let best: number | null = 0;
  for (const plan of ownedPlans) {
    const max = planLimit(plan, "workspaces");
    if (max === null) {
      best = null;
      break;
    }
    best = Math.max(best, max);
  }
  if (best !== null && ownedPlans.length >= best) {
    return new EntitlementError(limitUpgradeMessage("workspaces", best), "workspaces");
  }
  return null;
}
