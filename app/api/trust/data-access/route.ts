// ShapesOS — Phase 18.3 (WS=trust): the data access log.
//   GET /api/trust/data-access?scope=me|workspace&group=&before=
//     → { rows: DataAccessRow[] }
// scope=me (viewer+): what agents read in runs the caller started.
// scope=workspace (admin+): every agent read in the workspace.
// Derived from AgentRunEvent tool steps + OpsAuditEvent reads (lib/privacy/data-access.ts).

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { roleAtLeast } from "@/lib/authz";
import { isToolGroup } from "@/lib/agents/grants";
import { loadDataAccess } from "@/lib/privacy/data-access";
import { NO_STORE, trustGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ctx = await trustGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const q = req.nextUrl.searchParams;
    const workspaceWide = q.get("scope") === "workspace";
    if (workspaceWide && !roleAtLeast(ctx.role, "admin")) return Response.json({ error: "This needs the admin role." }, { status: 403 });
    const group = q.get("group");
    const before = q.get("before") ? new Date(q.get("before")!) : null;
    const rows = await loadDataAccess({
      workspaceId: ctx.workspaceId,
      forUserId: workspaceWide ? null : ctx.userId,
      group: isToolGroup(group) ? group : null,
      before: before && !Number.isNaN(before.getTime()) ? before : null,
    });
    return Response.json({ rows }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/trust/data-access");
  }
}
