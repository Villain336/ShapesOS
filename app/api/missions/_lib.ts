// Marketr — /api/missions shared guard (not a route: no HTTP exports).
//
// Mirrors app/api/authority/_lib.ts: signed-in user → their workspace,
// mutations require editor+. Tenant scoping goes through
// withWorkspaceScope (lib/substrate/graph/rls) + where: { workspaceId }
// defense in depth in lib/missions/prisma-store.ts.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, getMembership, forbidden } from "@/lib/authz";
import type { LoadedMission, EngineDeps } from "@/lib/missions/engine";
import { createPrismaMissionStore } from "@/lib/missions/prisma-store";
import { isWorkspaceFrozen } from "@/lib/orchestrator/killswitch";
import type { StoredMission, StoredMissionApproval } from "@/lib/missions/store";
import { BUSINESS_TYPE_LABELS, type BusinessType } from "@/lib/missions/templates";

export interface MissionsGuard {
  userId: string;
  workspaceId: string;
  role: string;
}

/**
 * Engine deps for the API layer. NOTE: killswitch.isMissionPaused queries
 * without the tenant GUC (M1 gap — FORCE RLS hides all rows), so the pause
 * check is store-backed and GUC-scoped here.
 */
export function missionDeps(): EngineDeps {
  const store = createPrismaMissionStore();
  return {
    store,
    isWorkspaceFrozen,
    isMissionPaused: async (missionId: string, workspaceId: string) =>
      (await store.getMission(missionId, workspaceId))?.status === "paused",
  };
}

/** Session guard. Mutations pass "editor"; reads pass "viewer". */
export async function missionsGuard(
  min: "viewer" | "editor" = "viewer",
): Promise<MissionsGuard | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (min === "editor" && !(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return forbidden();
  }
  const membership = await getMembership(user.id, workspace.id);
  return { userId: user.id, workspaceId: workspace.id, role: membership?.role ?? "viewer" };
}

export function badRequest(message: string, issues?: unknown) {
  return Response.json({ error: message, ...(issues ? { issues } : {}) }, { status: 400 });
}

/** Map service-layer safety errors to HTTP (err.status honored; 404 when missing). */
export function safetyError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  let status = 422;
  if (err instanceof Error) {
    const withStatus = err as Error & { status?: unknown };
    if (typeof withStatus.status === "number") status = withStatus.status;
  }
  if (status === 422 && /not found/i.test(message)) status = 404;
  return Response.json({ error: message }, { status });
}

/** Parse a JSON request body (empty/invalid -> {}). */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (!text.trim()) return {};
    return (JSON.parse(text) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : d;
}

export function serializeMission(m: StoredMission) {
  const goal = m.goal as {
    label?: string;
    metric?: string;
    targetValue?: number;
    unit?: string;
    timeframeDays?: number;
    direction?: string;
    baseline?: number | null;
  };
  return {
    id: m.id,
    workspaceId: m.workspaceId,
    template: m.template,
    businessType: (m.template.split(".")[0] ?? "") as BusinessType,
    businessTypeLabel: BUSINESS_TYPE_LABELS[(m.template.split(".")[0] ?? "") as BusinessType] ?? m.template,
    name: goal.label ?? m.template,
    goal,
    status: m.status,
    planSnapshot: m.planSnapshot,
    checkpoints: m.checkpoints,
    budgetCaps: m.budgetCaps,
    termination: m.termination,
    createdBy: m.createdBy,
    createdAt: iso(m.createdAt),
    updatedAt: iso(m.updatedAt),
  };
}

export function serializeApproval(a: StoredMissionApproval) {
  return {
    id: a.id,
    missionId: a.missionId,
    workspaceId: a.workspaceId,
    action: a.action,
    tier: a.tier,
    bindingJson: a.bindingJson,
    bindingHash: a.bindingHash,
    status: a.status,
    decidedBy: a.decidedBy,
    decidedAt: iso(a.decidedAt),
    expiresAt: iso(a.expiresAt),
    createdBy: a.createdBy,
    createdAt: iso(a.createdAt),
  };
}

/** Dense-list fields for GET /api/missions (spec §4: name, goal, progress, status, next checkpoint). */
export function toListItem(loaded: LoadedMission) {
  const m = serializeMission(loaded.mission);
  const goal = m.goal;
  const goalSummary =
    goal.metric && goal.targetValue !== undefined
      ? `${goal.metric}: ${goal.targetValue}${goal.unit ? ` ${goal.unit}` : ""} in ${goal.timeframeDays ?? "?"}d`
      : "—";
  return {
    id: m.id,
    name: m.name,
    template: m.template,
    businessType: m.businessType,
    businessTypeLabel: m.businessTypeLabel,
    goalSummary,
    status: m.status,
    progress: loaded.progress,
    nextCheckpoint: loaded.nextCheckpoint,
    totalCostCents: loaded.totalCostCents,
    estimatedCostCents: loaded.estimatedCostCents,
    createdAt: m.createdAt,
  };
}

export function serializeEvent(e: {
  id: string;
  ts: Date | string;
  actor: string;
  step: string | null;
  tool: string | null;
  args: Record<string, unknown>;
  observation: Record<string, unknown>;
  costCents: number;
  eventHash: string;
  prevHash: string;
}) {
  return {
    id: e.id,
    ts: e.ts instanceof Date ? e.ts.toISOString() : e.ts,
    actor: e.actor,
    step: e.step,
    tool: e.tool,
    args: e.args,
    observation: e.observation,
    costCents: e.costCents,
    eventHash: e.eventHash,
    prevHash: e.prevHash,
  };
}
