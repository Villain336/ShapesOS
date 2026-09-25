// Marketr — /api/substrate/memory shared guard + audit (Phase 8 G3).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest } from "@/lib/route-utils";
import { memoryAudit } from "@/lib/substrate/memory/audit";

export { badRequest, forbidden, memoryAudit };

export interface MemoryGuard {
  userId: string;
  workspaceId: string;
  role: string;
}

/** Session → workspace guard. Mutations pass "editor"; reads pass "viewer". */
export async function memoryGuard(
  req: NextRequest,
  min: "viewer" | "editor" = "viewer",
): Promise<MemoryGuard | Response> {
  const user = await requireUser();
  if (!user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspaceId = workspaceIdFrom(req);
  if (!workspaceId) return badRequest("workspaceId is required");
  const membership = await requireWorkspaceRole(user.id, workspaceId, min);
  if (!membership) return forbidden();
  return { userId: user.id, workspaceId, role: membership.role };
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (!text.trim()) return {};
    return (JSON.parse(text) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}
