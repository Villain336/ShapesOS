// Marketr — /api/orchestrator shared guard (not a route: no HTTP exports).
//
// Phase 9 orchestrator namespace (SPEC-PHASE9.md §P9B). Replicates the
// substrateGuard("viewer") semantics from app/api/substrate/_lib.ts for
// this namespace: session -> workspace; reads need viewer, mutations need
// editor.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, getMembership, forbidden } from "@/lib/authz";

export interface OrchestratorGuard {
  userId: string;
  workspaceId: string;
  role: string;
}

/** Session guard. Mutations pass "editor"; reads pass "viewer". */
export async function orchestratorGuard(
  min: "viewer" | "editor" = "viewer",
): Promise<OrchestratorGuard | Response> {
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
