// ShapesOS Phase 10 (ops-core): timesheets across projects.
//   GET  ?status=pending|approved|rejected &userId= &projectId=  (viewer+)
//   POST { entryIds: string[], decision: "approved" | "rejected" } (editor+)
// Only pending, unbilled entries move; who decided + when are recorded and
// the batch is audited (lib/ops/timesheets.ts decideTimesheet).

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { decideTimesheet, listTimesheet } from "@/lib/ops/timesheets";
import { OpsError } from "@/lib/ops/doctype";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

async function guard(min: "viewer" | "editor") {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, min))) {
    return Response.json({ error: `Forbidden: ${min} role required` }, { status: 403 });
  }
  return { workspaceId: workspace.id, userId: user.id };
}

function fail(err: unknown) {
  if (err instanceof OpsError) return Response.json({ error: err.message }, { status: err.status });
  return errorResponse(err);
}

export async function GET(req: NextRequest) {
  const actor = await guard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const q = req.nextUrl.searchParams;
    const status = q.get("status");
    const filter = {
      status: status && ["pending", "approved", "rejected"].includes(status) ? status : undefined,
      userId: q.get("userId")?.slice(0, 128) || undefined,
      projectId: q.get("projectId")?.slice(0, 64) || undefined,
    };
    const entries = await withWorkspaceScope(actor.workspaceId, (tx) => listTimesheet(tx, actor, filter));
    return Response.json({ entries });
  } catch (err) {
    return fail(err);
  }
}

const Decision = z.object({
  entryIds: z.array(z.string().min(1).max(64)).min(1).max(500),
  decision: z.enum(["approved", "rejected"]),
});

export async function POST(req: Request) {
  const actor = await guard("editor");
  if (actor instanceof Response) return actor;
  try {
    const parsed = validateBody(Decision, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    const result = await withWorkspaceScope(actor.workspaceId, (tx) =>
      decideTimesheet(tx, actor, parsed.data.entryIds, parsed.data.decision),
    );
    return Response.json(result);
  } catch (err) {
    return fail(err);
  }
}
