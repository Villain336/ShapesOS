// ShapesOS Phase 10 (ops-core): POST /api/ops/projects/[id]/invoice-time
//   { invoiceId?: string }
// Bills the project's APPROVED, unbilled, billable time: creates real line
// items on a new draft invoice (or appends to the given draft) through the
// invoice DocType service, and marks every entry billed with the invoice id
// in the same transaction — exactly once. Sending stays gated. Editor+.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { invoiceUnbilledTime } from "@/lib/ops/timesheets";
import { OpsError } from "@/lib/ops/doctype";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

const Body = z.object({ invoiceId: z.string().min(1).max(64).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return Response.json({ error: "Forbidden: editor role required" }, { status: 403 });
  }
  try {
    const { id } = await params;
    const raw = await req.text();
    const parsed = validateBody(Body, raw.trim() ? JSON.parse(raw) : {});
    if (!parsed.ok) return parsed.error;
    const actor = { workspaceId: workspace.id, userId: user.id };
    const result = await withWorkspaceScope(workspace.id, (tx) => invoiceUnbilledTime(tx, actor, id, parsed.data));
    return Response.json(result);
  } catch (err) {
    if (err instanceof SyntaxError) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    if (err instanceof OpsError) return Response.json({ error: err.message }, { status: err.status });
    return errorResponse(err);
  }
}
