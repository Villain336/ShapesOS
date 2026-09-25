// Marketr — /api/flywheel shared guard (not a route: no HTTP exports).
//
// Mirrors app/api/authority/_lib.ts: signed-in user → their workspace,
// mutations require editor+.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, getMembership, forbidden } from "@/lib/authz";
import { createTestLabAuditLog, type TestLabAuditLog } from "@/lib/flywheel/testlab/experiment";

export interface FlywheelGuard {
  userId: string;
  workspaceId: string;
  role: string;
}

/** Session guard. Mutations pass "editor"; reads pass "viewer". */
export async function flywheelGuard(
  min: "viewer" | "editor" = "viewer",
): Promise<FlywheelGuard | Response> {
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

/** Map service-layer errors to HTTP (422 fail-closed; 404 when missing). */
export function flywheelError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const status = /not found/i.test(message) ? 404 : 422;
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

// Process-local audit log for lifecycle transitions + verdicts.
// (Persistent audit table is a Phase-7-wide decision; events carry the full
// hash chain and are exportable for the future store.)
const _audit: TestLabAuditLog = createTestLabAuditLog();

export function testlabAudit() {
  return _audit;
}
