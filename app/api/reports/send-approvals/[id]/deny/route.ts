// Marketr — Phase 16 slice 9: branded report engine API.
// POST /api/reports/send-approvals/[id]/deny  { note? }  (editor+)
// Denials are never silent — the gate writes an audit entry.

import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { denyReportSend } from "@/lib/reports/report-gate";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await params;

  let body: { note?: string } = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine
  }

  try {
    await denyReportSend(prisma, { workspaceId: workspace.id, id, actor: user.id, note: body.note });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Deny failed" }, { status: 400 });
  }
}
