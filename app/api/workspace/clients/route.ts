// ShapesOS — agency client records (Phase 3, workstream I).
// GET  /api/workspace/clients → { clients, canEdit } (any member)
// POST /api/workspace/clients { name, loginEmail, viewerRole?, reportSchedule? } (admin+)
// Rules: lib/workspace/clients.ts.

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast, forbidden } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { createClient, listClients } from "@/lib/workspace/clients";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const me = await getMembership(user.id, workspace.id);
    if (!me) return forbidden();
    return Response.json({ clients: await listClients(workspace.id), canEdit: roleAtLeast(me.role, "admin") });
  } catch (err) {
    return errorResponse(err, "GET /api/workspace/clients");
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const me = await getMembership(user.id, workspace.id);
    if (!roleAtLeast(me?.role, "admin")) return forbidden("Managing clients needs the admin role.");
    const body = await req.json().catch(() => null);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const client = await createClient(workspace.id, user.id, body);
    return Response.json({ client: { id: client.id, name: client.name } }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/workspace/clients");
  }
}
