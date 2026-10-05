// ShapesOS — Phase 15.3 (pricing): "not in your plan" notice for the pages of
// a plan-gated feature (digital twin, POS, payroll). Server component: reads
// the workspace's plan and renders nothing when the plan includes the
// feature (always the case on self-hosted and trial), so those workspaces
// look exactly as before. The server gates (opsCreate createEntitlement,
// computePayRun, createSiteRow) are what actually enforce it; this only
// explains the 403 before someone hits it.

import { planOf } from "@/lib/billing/entitlements-server";
import {
  featureUpgradeMessage,
  limitUpgradeMessage,
  planHasFeature,
  planLimit,
  type Feature,
  type LimitKey,
} from "@/lib/billing/entitlements";
import { requireWorkspaceRole } from "@/lib/authz";
import { UpgradeNotice } from "./UpgradeNotice";

export async function PlanFeatureNotice({
  workspaceId,
  userId,
  feature,
  limit,
}: {
  workspaceId: string;
  userId: string;
  feature: Feature;
  /** Optional numeric limit to warn about once reached (e.g. twin sites). */
  limit?: { key: LimitKey; used: number };
}) {
  const plan = await planOf(workspaceId);
  let message: string | null = null;
  if (!planHasFeature(plan, feature)) {
    message = featureUpgradeMessage(feature);
  } else if (limit) {
    const max = planLimit(plan, limit.key);
    if (max !== null && limit.used >= max) message = limitUpgradeMessage(limit.key, max);
  }
  if (!message) return null;
  const canManageBilling = !!(await requireWorkspaceRole(userId, workspaceId, "admin"));
  return <UpgradeNotice message={message} canManageBilling={canManageBilling} />;
}
