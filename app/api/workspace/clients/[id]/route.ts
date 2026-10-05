// ShapesOS — one agency client record (Phase 3, workstream I).
// PATCH  /api/workspace/clients/[id] { name?, loginEmail?, viewerRole?, reportSchedule? } (admin+)
// DELETE /api/workspace/clients/[id] { confirmName } (admin+; deletes the client's reports)

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast, forbidden } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { deleteClient, updateClient } from "@/lib/workspace/clients";

export const dynamic = "force-dynamic";

async function adminGate() {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await getMembership(user.id, workspace.id);
  if (!roleAtLeast(me?.role, "admin")) return { error: forbidden("Managing clients needs the admin role.") } as const;
  return { user, workspace } as const;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const g = await adminGate();
    if ("error" in g) return g.error;
    const { id } = await params;
    const body = await req.json().catch(() => null);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const client = await updateClient(g.workspace.id, g.user.id, id, body);
    return Response.json({ client: { id: client.id, name: client.name } });
  } catch (err) {
    return errorResponse(err, "PATCH /api/workspace/clients/[id]");
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const g = await adminGate();
    if ("error" in g) return g.error;
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { confirmName?: unknown } | null;
    return Response.json({ ok: true, deleted: await deleteClient(g.workspace.id, g.user.id, id, body?.confirmName) });
  } catch (err) {
    return errorResponse(err, "DELETE /api/workspace/clients/[id]");
  }
}
