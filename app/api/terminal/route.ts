// ShapesOS — Phase 18.2 (WS=content): the Terminal.
// GET  /api/terminal → { available: {ok, provider|reason}, canUse, session, history }
//        any member may ask (the page shows a viewer why it's off); session =
//        the person's own open terminal (idled-out ones are closed first)
// POST /api/terminal → { session, resumed } — open (or resume) the person's
//        terminal on a workspace sandbox. editor+ (requireWorkspaceRole);
//        503 with the reason when no sandbox provider is configured; audited
//        (terminal_session_started). lib/terminal/service.ts has the rules.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole, roleAtLeast } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { myTerminalSession, startTerminalSession, terminalAvailability, terminalHistory } from "@/lib/terminal/service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "viewer");
    if (!m) return forbidden();
    const actor = { workspaceId: workspace.id, userId: user.id, role: m.role };
    const canUse = roleAtLeast(m.role, "editor");
    const [available, session] = await Promise.all([terminalAvailability(), canUse ? myTerminalSession(actor) : Promise.resolve(null)]);
    const history = session ? await terminalHistory(actor, session.id) : [];
    return Response.json({ available, canUse, session, history }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/terminal");
  }
}

export async function POST() {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "editor");
    if (!m) return forbidden();
    const res = await startTerminalSession({ workspaceId: workspace.id, userId: user.id, role: m.role });
    return Response.json(res, { status: res.resumed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/terminal");
  }
}
