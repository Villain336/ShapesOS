// ShapesOS — one workspace (Phase 3, workstream I).
// PATCH  /api/workspaces/[id] { name }         → rename (admin+)
// DELETE /api/workspaces/[id] { confirmName }  → delete (owner only; the
//   workspace name typed back exactly; refused for your last workspace and
//   while a paid subscription is live). Rules in lib/workspace/lifecycle.ts.

import { NextResponse, type NextRequest } from "next/server";
import { requireUser, ACTIVE_WORKSPACE_COOKIE } from "@/lib/session";
import { errorResponse } from "@/lib/api/errors";
import { deleteWorkspace, renameWorkspace } from "@/lib/workspace/lifecycle";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const ws = await renameWorkspace({ userId: user.id, workspaceId: id, name: body.name });
    return Response.json({ workspace: { id: ws.id, name: ws.name } });
  } catch (err) {
    return errorResponse(err, "PATCH /api/workspaces/[id]");
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { confirmName?: unknown } | null;
    const result = await deleteWorkspace({ userId: user.id, workspaceId: id, confirmName: body?.confirmName });
    const res = NextResponse.json({ ok: true, deleted: result });
    // The preference cookie may name the deleted workspace; drop it so the
    // next page load falls back to another workspace the user can access.
    res.cookies.set(ACTIVE_WORKSPACE_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    return errorResponse(err, "DELETE /api/workspaces/[id]");
  }
}
