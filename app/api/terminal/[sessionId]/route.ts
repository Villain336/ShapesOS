// ShapesOS — Phase 18.2 (WS=content): one terminal session.
// GET    /api/terminal/[sessionId] → { history } — the person's own commands
//          in it (never anyone else's). editor+.
// DELETE /api/terminal/[sessionId] → { ended } — close it: the sandbox is
//          destroyed, paid minutes metered, the end audited. The person's own
//          session, or any session for an admin (requireWorkspaceRole editor+
//          here; the owner/admin rule in lib/terminal/service.ts closeOwnTerminal).

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { closeOwnTerminal, terminalHistory } from "@/lib/terminal/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { sessionId } = await ctx.params;
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "editor");
    if (!m) return forbidden();
    const history = await terminalHistory({ workspaceId: workspace.id, userId: user.id, role: m.role }, sessionId);
    return Response.json({ history }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/terminal/[sessionId]");
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { sessionId } = await ctx.params;
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "editor");
    if (!m) return forbidden();
    const ended = await closeOwnTerminal({ workspaceId: workspace.id, userId: user.id, role: m.role }, sessionId);
    return Response.json({ ended });
  } catch (err) {
    return errorResponse(err, "DELETE /api/terminal/[sessionId]");
  }
}
