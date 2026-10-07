// ShapesOS — Phase 19B (WS=panel): the /api/rehearsal routes' guard.
// The signed-in person in their CURRENT workspace with at least `min`
// (requireWorkspaceRole); 401 signed out, 403 below the role. The
// dress_rehearsal entitlement (403 upgrade_required) is checked by every
// service call (lib/panel/service.server.ts gate), so routes, the page and
// the agent tools share one gate.

import type { WorkspaceRole } from "@prisma/client";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import type { PanelActor } from "@/lib/panel/service.server";

export async function rehearsalGuard(min: WorkspaceRole): Promise<PanelActor | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const m = await requireWorkspaceRole(user.id, workspace.id, min);
  if (!m) return forbidden();
  return { userId: user.id, workspaceId: workspace.id, role: m.role };
}

/** A JSON object body (≤ max bytes), or null. */
export async function readJson(req: Request, max = 65_536): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > max) return null;
  try {
    const v = JSON.parse(text || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const badBody = () => Response.json({ error: "Send a JSON object." }, { status: 400 });

export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : []);
