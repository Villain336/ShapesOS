// Marketr — shared cron route gate (day-1 hardening, M1).
//
// Every /api/cron/* route accepts exactly two actors:
//   1. CRON_SECRET service call: Authorization: Bearer <CRON_SECRET>.
//      The scheduler — bypasses user roles, runs across all workspaces.
//   2. Signed-in session: runs the sweep scoped to the user's workspace,
//      and requires editor+ on that workspace. A viewer must not force-run
//      sweeps that send, publish, or spend.
//
// Centralized here (was copy-pasted across 12 routes) so the rule is tested
// once and can't drift per-route.

import { requireWorkspaceRole } from "@/lib/authz";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";

export interface CronGate {
  isCron: boolean;
  userId: string | null;
  /** The caller's workspace for session-triggered runs; null for CRON_SECRET. */
  workspaceId: string | null;
}

/**
 * Evaluate the cron gate for a request. Accepts a plain Request (only
 * headers are read), so the gate is unit-testable outside Next.js.
 * Returns the gate on success, or a 401/403 Response the route should
 * return directly.
 */
export async function cronGate(req: Request): Promise<CronGate | Response> {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  const header = req.headers.get("authorization") ?? "";
  const isCron = !!secret && header === `Bearer ${secret}`;
  const user = isCron ? null : await requireUser();
  if (!isCron && !user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspaceId =
    isCron || !user ? null : (await getOrCreateWorkspace(user.id, user.email)).id;
  if (!isCron && user && !(await requireWorkspaceRole(user.id, workspaceId!, "editor"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return { isCron, userId: user?.id ?? null, workspaceId };
}
