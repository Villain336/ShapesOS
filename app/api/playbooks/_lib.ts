// Marketr — /api/playbooks shared guard (not a route: no HTTP exports).
//
// Session → workspace; reads need viewer, mutations need editor. Mirrors
// app/api/substrate/_lib.ts conventions.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, getMembership, forbidden } from "@/lib/authz";

export interface PlaybooksGuard {
  userId: string;
  workspaceId: string;
  role: string;
}

/** Session guard. Mutations pass "editor"; reads pass "viewer". */
export async function playbooksGuard(
  min: "viewer" | "editor" = "viewer",
): Promise<PlaybooksGuard | Response> {
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

/** Map store errors to HTTP: not-found → 404, guard violations → 422, else 500. */
export function storeError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (/not found in this workspace|no production version/i.test(message)) {
    return Response.json({ error: message }, { status: 404 });
  }
  if (
    /not allowed|quarantined|opt-in|requires|must be|immutable/i.test(message)
  ) {
    return Response.json({ error: message }, { status: 422 });
  }
  return Response.json({ error: message }, { status: 500 });
}
