// Marketr — GET /api/experiments/flags
// List GrowthBook feature definitions for the experiments settings page,
// with this workspace's overrides applied (effectiveValue / overridden).
// Admin+ only. Without a configured GrowthBook sidecar → 200 with the
// source "defaults" and an honest message (the page shows Marketr's
// built-in flag defaults instead).

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import {
  GrowthBookApiError,
  applyFlagOverrides,
  listGrowthBookFeatures,
  marketrFlagDefaults,
  type GrowthBookFeature,
} from "@/lib/integrations/growthbook";
import { getWorkspaceFlagOverrides } from "@/lib/integrations/growthbook-overrides";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) return Response.json({ error: "Forbidden" }, { status: 403 });

  const overrides = await getWorkspaceFlagOverrides(workspace.id);
  try {
    const features = await listGrowthBookFeatures();
    return Response.json({
      features: applyFlagOverrides(features, overrides),
      source: "growthbook",
    });
  } catch (e) {
    if (e instanceof GrowthBookApiError && e.status === 0) {
      // Honest fallback: show the flags Marketr actually wires, with their
      // built-in defaults, so the page is still meaningful.
      const defaults = marketrFlagDefaults();
      const features: GrowthBookFeature[] = Object.entries(defaults).map(([id, defaultValue]) => ({
        id,
        valueType: "boolean" as const,
        defaultValue,
        description: "ShapesOS built-in flag (GrowthBook not connected)",
        rulesCount: 0,
      }));
      return Response.json({
        features: applyFlagOverrides(features, overrides),
        source: "defaults",
        message: e.message,
      });
    }
    throw e;
  }
}
