// Marketr — Phase 16 slice 9: branded report engine API.
// POST /api/reports/send-approvals/[id]/edit  { clientName?, period?, meta?, figures? }  (editor+)
// Edit is update-then-requeue-pending: the report stays in the approval queue
// and must still be approved before it can render. Editing figures re-runs the
// grounding evaluation (may flip the report to `flagged`).

import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { editReportSend } from "@/lib/reports/report-gate";
import type { ReportFigure } from "@/lib/reports/figures";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await params;

  let body: { clientName?: string; period?: string; meta?: Record<string, string>; figures?: ReportFigure[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const approval = await editReportSend(prisma, {
      workspaceId: workspace.id,
      id,
      actor: user.id,
      clientName: body.clientName,
      period: body.period,
      meta: body.meta,
      figures: body.figures,
    });
    return Response.json({ ok: true, approval });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Edit failed" }, { status: 400 });
  }
}
