// Marketr — /api/flywheel/dsp shared guard (not a route: no HTTP exports).
//
// Mirrors app/api/authority/_lib.ts: signed-in user → their workspace,
// mutations require editor+. v1 is fixture/in-memory backed until the
// coordinator merges prisma/fragments/phase7-dsp.prisma and provisions SQL
// stores (the memory stores share the same interfaces).

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, getMembership, forbidden } from "@/lib/authz";

export interface DspGuard {
  userId: string;
  workspaceId: string;
  role: string;
}

export async function dspGuard(min: "viewer" | "editor" = "viewer"): Promise<DspGuard | Response> {
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

/** Map service-layer fail-closed errors to HTTP (422 fail-closed; 404 when missing). */
export function dspError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const status = /not found/i.test(message) ? 404 : 422;
  return Response.json({ error: message }, { status });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (!text.trim()) return {};
    return (JSON.parse(text) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}
