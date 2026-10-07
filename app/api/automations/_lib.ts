// ShapesOS — Phase 18.3 (WS=flow): the Automations / Time Machine routes'
// guard. The signed-in person in their CURRENT workspace with at least
// `min` (requireWorkspaceRole); 401 signed out, 403 below the role.

import type { WorkspaceRole } from "@prisma/client";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";

export interface FlowCtx {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

export async function flowGuard(min: WorkspaceRole): Promise<FlowCtx | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const m = await requireWorkspaceRole(user.id, workspace.id, min);
  if (!m) return forbidden();
  return { userId: user.id, workspaceId: workspace.id, role: m.role };
}

export async function readJsonObject(req: Request, max = 16_384): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > max) return null;
  try {
    const v = JSON.parse(text || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
