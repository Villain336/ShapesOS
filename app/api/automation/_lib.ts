// Marketr — /api/automation shared guard (not a route: no HTTP exports).
//
// Phase 9 M6 (docs/specs/SPEC-PHASE9.md §P9E). Session → workspace; reads need viewer,
// mutations need editor. Mirrors app/api/substrate/_lib.ts conventions:
// every DB access goes through withWorkspaceScope() (tenant GUC via
// SET LOCAL — fail-closed RLS) AND `where: { workspaceId }` as defense in
// depth.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, getMembership, forbidden } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";

export interface AutomationGuard {
  userId: string;
  workspaceId: string;
  role: string;
}

/** Session guard. Mutations pass "editor"; reads pass "viewer". */
export async function automationGuard(
  min: "viewer" | "editor" = "viewer",
): Promise<AutomationGuard | Response> {
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

/** Map DecideError (and friends) to HTTP responses. */
export function decideError(err: unknown) {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return Response.json({ error: err instanceof Error ? err.message : "Decide failed" }, { status: (err as { status: number }).status });
  }
  return errorResponse(err);
}
