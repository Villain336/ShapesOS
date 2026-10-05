// ShapesOS — Phase 10 (portal): POST /api/workspace/clients/[id]/portal/revoke
// { sessionId? } — sign a client out of the portal: one session, or every
// live session when sessionId is omitted (admin+). Audited.

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast, forbidden } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { revokeClientPortalSessions } from "@/lib/portal/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const me = await getMembership(user.id, workspace.id);
    if (!roleAtLeast(me?.role, "admin")) return forbidden("Managing client portal access needs the admin role.");
    const body = ((await req.json().catch(() => null)) ?? {}) as { sessionId?: unknown };
    const revoked = await revokeClientPortalSessions(workspace.id, user.id, (await params).id, body.sessionId);
    return Response.json({ revoked });
  } catch (err) {
    return errorResponse(err, "POST /api/workspace/clients/[id]/portal/revoke");
  }
}
