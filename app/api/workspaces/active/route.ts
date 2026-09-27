// Marketr — active workspace switch (Phase 13 Wave A, white-label ops).
// POST /api/workspaces/active  { workspaceId } → { ok: true, workspaceId }
// Any member of a workspace may switch to it; switching is scoping, not
// privilege — every API route still enforces its own RBAC for the resolved
// workspace. The id is validated against the user's accessible workspaces,
// so a forged value can never widen access. Sets the httpOnly
// marketr_active_workspace preference cookie honored by
// getOrCreateWorkspace (lib/session.ts).

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireUser, getAccessibleWorkspaces, ACTIVE_WORKSPACE_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { workspaceId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId.trim().slice(0, 120) : "";
  if (!workspaceId) {
    return Response.json({ error: "workspaceId is required" }, { status: 400 });
  }

  const accessible = await getAccessibleWorkspaces(user.id);
  const target = accessible.find((w) => w.id === workspaceId);
  if (!target) {
    // 404 (not 403): no membership information leaks.
    return Response.json({ error: "Workspace not found" }, { status: 404 });
  }

  const res = NextResponse.json({ ok: true, workspaceId: target.id, name: target.name });
  // NextResponse (not the plain web Response) exposes the cookie jar.
  res.cookies.set(ACTIVE_WORKSPACE_COOKIE, target.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
