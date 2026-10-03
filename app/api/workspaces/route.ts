// ShapesOS — workspaces (Phase 3, workstream I).
// GET  /api/workspaces           → { workspaces: [{ id, name, plan, role, current }] }
// POST /api/workspaces { name }  → create a workspace you own, and switch to it.
//   The plan follows DEPLOYMENT_MODE (lib/billing/trial.ts). Audited in
//   workspace_lifecycle_events + the new workspace's audit log.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getAccessibleWorkspaces, getOrCreateWorkspace, ACTIVE_WORKSPACE_COOKIE } from "@/lib/session";
import { errorResponse } from "@/lib/api/errors";
import { createWorkspaceForUser } from "@/lib/workspace/lifecycle";
import { mayCreateWorkspace } from "@/lib/auth/signup";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const current = await getOrCreateWorkspace(user.id, user.email);
    const [workspaces, memberships] = await Promise.all([
      getAccessibleWorkspaces(user.id),
      prisma.workspaceMember.findMany({ where: { userId: user.id }, select: { workspaceId: true, role: true } }),
    ]);
    const roleOf = new Map(memberships.map((m) => [m.workspaceId, m.role]));
    return Response.json({
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        plan: w.plan,
        role: roleOf.get(w.id) ?? (w.ownerUserId === user.id ? "owner" : null),
        current: w.id === current.id,
      })),
    });
  } catch (err) {
    return errorResponse(err, "GET /api/workspaces");
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await mayCreateWorkspace(user.id))) {
      return Response.json({ error: "An invite is required to create a workspace here." }, { status: 403 });
    }
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const workspace = await createWorkspaceForUser({ userId: user.id, name: body.name });
    const res = NextResponse.json(
      { workspace: { id: workspace.id, name: workspace.name, plan: workspace.plan } },
      { status: 201 },
    );
    // Switch to the new workspace (same preference cookie as /api/workspaces/active).
    res.cookies.set(ACTIVE_WORKSPACE_COOKIE, workspace.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
      secure: process.env.NODE_ENV === "production",
    });
    return res;
  } catch (err) {
    return errorResponse(err, "POST /api/workspaces");
  }
}
