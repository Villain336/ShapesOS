// Marketr — autopilot approval gate: publish (milestone 18).
// POST /api/autopilot/items/[id]/publish  { projectId }  (editor+)
// Approved items only. programmatic_page → M17 push path; decay/keyword →
// site-IDE working copy refresh. Kill switch enforced.

import { accessibleWorkspaceWhere, forbidden, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { publishAutopilotItem } from "@/lib/seo/autopilot-service";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  let body: { projectId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const project = await prisma.project.findFirst({
    where: { id: body.projectId ?? "", workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true },
  });
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();

  try {
    const result = await publishAutopilotItem(prisma, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      itemId: id,
      actor: user.id,
      userId: user.id,
    });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Publish failed";
    return Response.json({ error: msg }, { status: /killed/i.test(msg) ? 423 : 502 });
  }
}
