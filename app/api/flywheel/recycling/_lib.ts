// Marketr — /api/flywheel/recycling shared guard (not a route: no HTTP exports).
//
// Namespaced under recycling/ so the other Phase 7 tracks can own their own
// helpers without collision. Mirrors app/api/media/_lib.ts: signed-in user →
// their workspace, mutations require editor+.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";

export interface FlywheelGuard {
  userId: string;
  workspaceId: string;
}

/** Session guard. Mutations pass "editor"; reads pass "viewer". */
export async function recyclingGuard(
  min: "viewer" | "editor" = "viewer",
): Promise<FlywheelGuard | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (min === "editor" && !(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return forbidden();
  }
  return { userId: user.id, workspaceId: workspace.id };
}

export function badRequest(message: string, issues?: unknown) {
  return Response.json({ error: message, ...(issues ? { issues } : {}) }, { status: 400 });
}

export function notProvisioned() {
  return Response.json(
    { error: "Recycling tables not provisioned yet (Phase 7 fragment not merged/migrated)." },
    { status: 503 },
  );
}

/** Map service-layer recycling errors to HTTP (422 fail-closed; 404 when missing). */
export function recyclingError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const status = /not found in workspace/i.test(message) ? 404 : 422;
  return Response.json({ error: message }, { status });
}
