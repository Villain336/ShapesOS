// ShapesOS — Phase 10 (portal): Settings → Clients → Portal access.
// GET   /api/workspace/clients/[id]/portal → switch, linked records, pickable
//       records and recent portal sessions (admin+)
// PATCH /api/workspace/clients/[id]/portal { portalEnabled?, companyIds?,
//       contactIds?, leadIds? } (admin+). Turning the portal off revokes every
//       live portal session. Rules: lib/portal/admin.ts.

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast, forbidden } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { getClientPortalAdmin, updateClientPortal } from "@/lib/portal/admin";

export const dynamic = "force-dynamic";

async function adminGate() {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await getMembership(user.id, workspace.id);
  if (!roleAtLeast(me?.role, "admin")) return { error: forbidden("Managing client portal access needs the admin role.") } as const;
  return { user, workspace } as const;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const g = await adminGate();
    if ("error" in g) return g.error;
    return Response.json(await getClientPortalAdmin(g.workspace.id, (await params).id));
  } catch (err) {
    return errorResponse(err, "GET /api/workspace/clients/[id]/portal");
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const g = await adminGate();
    if ("error" in g) return g.error;
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return Response.json({ error: "Invalid JSON" }, { status: 400 });
    return Response.json(await updateClientPortal(g.workspace.id, g.user.id, (await params).id, body));
  } catch (err) {
    return errorResponse(err, "PATCH /api/workspace/clients/[id]/portal");
  }
}
