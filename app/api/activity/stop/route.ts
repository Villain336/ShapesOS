// ShapesOS — Phase 18.2 (WS=content): Stop a process from the Activity Monitor.
// POST /api/activity/stop { key: "run:<id>" | "job:<id>" | "sandbox:<id>" | "terminal:<id>" }
//   → { stopped: [...] }
// Access: requireWorkspaceRole (a member) + lib/aos/stop.server.ts: the person
// who started it, or an admin/owner for anyone's (checked against the row).
// Each kind stops through its EXISTING path (requestAgentRunCancel /
// stopThreadRuns, the job cancel, releaseRunSandbox, the terminal session end).

import { z } from "zod";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole, roleAtLeast } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { stopProcess } from "@/lib/aos/stop.server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "viewer");
    if (!m) return forbidden();
    const body = z.object({ key: z.string().min(3).max(100) }).parse(await req.json().catch(() => null));
    const res = await stopProcess(workspace.id, { userId: user.id, isAdmin: roleAtLeast(m.role, "admin") }, body.key);
    return Response.json(res);
  } catch (err) {
    return errorResponse(err, "POST /api/activity/stop");
  }
}
