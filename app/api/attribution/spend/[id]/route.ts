// Marketr — Attribution API: spend row update + delete.
// PATCH  /api/attribution/spend/[id] (editor+)
// DELETE /api/attribution/spend/[id] (editor+)

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { updateSpend, deleteSpend, SpendFieldsSchema } from "@/lib/attribution/spend";
import { errorResponse } from "@/lib/api/errors";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await ctx.params;

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = SpendFieldsSchema.partial().safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  if (
    parsed.data.periodStart &&
    parsed.data.periodEnd &&
    parsed.data.periodEnd.getTime() < parsed.data.periodStart.getTime()
  ) {
    return Response.json({ error: "periodEnd must be >= periodStart" }, { status: 400 });
  }
  try {
    const spend = await updateSpend(workspace.id, id, parsed.data);
    if (!spend) return Response.json({ error: "Spend entry not found" }, { status: 404 });
    return Response.json({ spend });
  } catch (e) {
    return errorResponse(e, "PATCH /api/attribution/spend/[id]");
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await ctx.params;

  const deleted = await deleteSpend(workspace.id, id);
  if (!deleted) return Response.json({ error: "Spend entry not found" }, { status: 404 });
  return Response.json({ deleted: id });
}
