// Marketr — /api/agents shared guard + helpers (Phase 13B, worker 5).
// Session → workspace guard mirroring app/api/substrate/memory/_lib.ts.
// Mutations require "editor"; reads accept "viewer". Every query on the
// Phase 13B tables MUST go through withWorkspaceScope (fail-closed RLS).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest } from "@/lib/route-utils";

export { badRequest, forbidden };

export interface AgentsGuard {
  userId: string;
  workspaceId: string;
  role: string;
}

/** Session → workspace guard. Mutations pass "editor"; reads pass "viewer". */
export async function agentsGuard(
  req: NextRequest,
  min: "viewer" | "editor" = "viewer",
  body?: { workspaceId?: unknown } | null,
): Promise<AgentsGuard | Response> {
  const user = await requireUser();
  if (!user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspaceId = workspaceIdFrom(req, body);
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
