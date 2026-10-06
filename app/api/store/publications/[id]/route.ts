// ShapesOS — Phase 18.2 (WS=content): one agency offer.
// POST   /api/store/publications/[id] { decision: "accept"|"decline" } → { status, installedKey }
//          the CLIENT workspace's admin answers (requireWorkspaceRole admin);
//          accept installs it here through the Store's paths. Audited.
// DELETE /api/store/publications/[id] → { ok } — the AGENCY's admin withdraws
//          an offer nobody answered yet (requireWorkspaceRole admin).

import { z } from "zod";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { decidePublication, revokePublication } from "@/lib/store/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ decision: z.enum(["accept", "decline"]) });

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await ctx.params;
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "admin");
    if (!m) return forbidden();
    const body = Body.parse(await req.json().catch(() => null));
    return Response.json(await decidePublication({ workspaceId: workspace.id, userId: user.id, role: m.role }, id, body.decision));
  } catch (err) {
    return errorResponse(err, "POST /api/store/publications/[id]");
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await ctx.params;
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "admin");
    if (!m) return forbidden();
    await revokePublication({ workspaceId: workspace.id, userId: user.id, role: m.role }, id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "DELETE /api/store/publications/[id]");
  }
}
