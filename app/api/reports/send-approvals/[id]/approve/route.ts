// Marketr — Phase 16 slice 9: branded report engine API.
// POST /api/reports/send-approvals/[id]/approve  → gate approve + WeasyPrint render (editor+)
// The render service re-checks figure grounding: ungrounded figures throw and
// the approval stays pending — no PDF, no silent render.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { approveReportSend } from "@/lib/reports/report-gate";
import { UngroundedFiguresError } from "@/lib/reports/figures";
import { scopedDb } from "@/lib/substrate/memory/rls";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await params;

  try {
    const approval = await approveReportSend(scopedDb(workspace.id), { workspaceId: workspace.id, id, actor: user.id });
    return Response.json({ ok: true, approval });
  } catch (err) {
    if (err instanceof UngroundedFiguresError) {
      // Guardrail: 422, report stays pending/flagged for sourcing.
      return Response.json({ error: err.message, ungroundedKeys: err.ungroundedKeys }, { status: 422 });
    }
    const msg = err instanceof Error ? err.message : "Approve failed";
    return Response.json({ error: msg }, { status: 400 });
  }
}
