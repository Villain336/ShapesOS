// ShapesOS — Phase 18.2 (WS=content): an agency offers an item to its clients.
// POST /api/store/publish { kind: "mini_app"|"skill"|"mission_template", key, clientWorkspaceIds: [...] }
//   → { published: [publicationId, …] }
// requireWorkspaceRole admin on the AGENCY workspace; every target must be one
// of its client workspaces (Workspace.creditPoolOwnerId = this Agency-plan
// workspace — lib/store/service.ts listClientWorkspaces). The client's admin
// accepts or declines in their Store. No payments. Audited.

import { z } from "zod";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { publishToClients } from "@/lib/store/service";

export const dynamic = "force-dynamic";

const Body = z.object({
  kind: z.string().max(32),
  key: z.string().min(1).max(120),
  clientWorkspaceIds: z.array(z.string().min(1).max(64)).min(1).max(200),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "admin");
    if (!m) return forbidden();
    const body = Body.parse(await req.json().catch(() => null));
    const res = await publishToClients({ workspaceId: workspace.id, userId: user.id, role: m.role }, body.kind, body.key, body.clientWorkspaceIds);
    return Response.json(res, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/store/publish");
  }
}
