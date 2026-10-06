// ShapesOS — Phase 18.2 (WS=content): the Store.
// GET /api/store → { items, unavailable, publications: { incoming, outgoing }, clients }
//   any member (requireWorkspaceRole viewer): the catalogue generated from
//   each registry with this workspace's installed state and every item's
//   tools at their approval tiers (lib/store/service.ts). clients = this
//   agency's client workspaces (admins of an Agency-plan workspace only).

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole, roleAtLeast } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { listClientWorkspaces, listPublications, loadStoreCatalogue } from "@/lib/store/service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "viewer");
    if (!m) return forbidden();
    const actor = { workspaceId: workspace.id, userId: user.id, role: m.role };
    const admin = roleAtLeast(m.role, "admin");
    const [catalogue, publications, clients] = await Promise.all([
      loadStoreCatalogue(actor),
      admin ? listPublications(actor) : Promise.resolve({ incoming: [], outgoing: [] }),
      admin ? listClientWorkspaces(workspace.id) : Promise.resolve([]),
    ]);
    return Response.json({ ...catalogue, publications, clients }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/store");
  }
}
