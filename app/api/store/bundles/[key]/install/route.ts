// ShapesOS Phase 24 - POST /api/store/bundles/[key]/install
//   { confirmed: true, members: ["skill:seo-audit", ...] } -> { bundle, results }
// editor+ here; every selected member then goes through its OWN install path
// and permission (lib/store/service.ts installStoreItem), so a bundle never
// grants more than installing each item one by one. Connectors / MCP servers
// are skipped with a pointer to Settings -> Connectors. Unselected members
// are untouched. `confirmed: true` is required: the UI shows each member's
// tier and needs first.

import { z } from "zod";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import { BadRequestError, errorResponse } from "@/lib/api/errors";
import { installBundle } from "@/lib/store/bundles-service";

export const dynamic = "force-dynamic";

const Body = z.object({
  confirmed: z.boolean().optional(),
  members: z.array(z.string().min(1).max(160)).min(1).max(30),
});

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "editor");
    if (!m) return forbidden();
    const body = Body.parse(await req.json().catch(() => null));
    if (body.confirmed !== true) throw new BadRequestError("Confirm what will be installed first (confirmed: true).");
    const { key } = await ctx.params;
    const out = await installBundle({ workspaceId: workspace.id, userId: user.id, role: m.role }, key, body.members);
    return Response.json(out);
  } catch (err) {
    return errorResponse(err, "POST /api/store/bundles/[key]/install");
  }
}
