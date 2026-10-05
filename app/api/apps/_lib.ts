// ShapesOS — Phase 9 (apps): shared guard + error mapping for /api/apps/*.
//
// appsGuard() authenticates, resolves the workspace and loads the caller's
// membership; a route passes the minimum workspace role it needs (reads:
// viewer). What a member may do inside an app — which views, which actions
// — is decided by the app's own spec in lib/apps/service.ts (roleAtLeast on
// the membership role below is the workspace floor; the spec only narrows).

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import type { WorkspaceRole } from "@prisma/client";
import { errorResponse } from "@/lib/api/errors";
import { AppError, OpsGateError, type AppActor } from "@/lib/apps/service";

export async function appsGuard(min: WorkspaceRole = "viewer"): Promise<AppActor | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const member = await getMembership(user.id, workspace.id);
  if (!member || !roleAtLeast(member.role, min)) {
    return Response.json({ error: `Forbidden: ${min} role required` }, { status: 403 });
  }
  return { userId: user.id, workspaceId: workspace.id, role: member.role };
}

export function appsError(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json(
      { error: err.message, ...(err.fields ? { fields: err.fields } : {}), ...(err.errors ? { errors: err.errors } : {}) },
      { status: err.status },
    );
  }
  // Fail closed: a gate refusal (no / wrong / replayed approval) is a 422.
  if (err instanceof OpsGateError) return Response.json({ error: err.message, code: err.code }, { status: 422 });
  return errorResponse(err);
}

export async function readJsonBody(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const text = await req.text();
    const body = text.trim() ? (JSON.parse(text) as unknown) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Expected a JSON object" }, { status: 400 });
    }
    return body as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
}
