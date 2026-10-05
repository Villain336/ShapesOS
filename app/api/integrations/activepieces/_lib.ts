// Marketr — /api/integrations/activepieces shared guard (Phase 12, Worker 3).
// Not a route: no HTTP exports. Session → workspace; mutations need editor+.
// The Activepieces API key lives on the host env and is never exposed here.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, getMembership, forbidden } from "@/lib/authz";

export interface IntegrationsGuard {
  userId: string;
  workspaceId: string;
  role: string;
}

export async function integrationsGuard(
  min: "viewer" | "editor" = "viewer",
): Promise<IntegrationsGuard | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (min === "editor" && !(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return forbidden();
  }
  const membership = await getMembership(user.id, workspace.id);
  return { userId: user.id, workspaceId: workspace.id, role: membership?.role ?? "viewer" };
}

/** Honest "engine not connected" JSON (503 — a config state, not a crash). */
export function notConnected() {
  return Response.json(
    {
      configured: false,
      error:
        "Activepieces is not connected. Set ACTIVEPIECES_URL and ACTIVEPIECES_API_KEY " +
        "on the host (Settings → Providers) to list and trigger flows.",
    },
    { status: 503 },
  );
}

export function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

export function engineError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name === "ActivepiecesNotConfiguredError") return notConnected();
  // Phase 1 (H6): unbound / foreign flows and runs are "not found".
  if (name === "FlowNotBoundError") return Response.json({ configured: true, error: message }, { status: 404 });
  if (name === "FlowBindingConflictError") return Response.json({ configured: true, error: message }, { status: 409 });
  const status = name === "ActivepiecesApiError" && (err as { status?: number }).status === 404 ? 404 : 502;
  return Response.json({ configured: true, error: message }, { status });
}
