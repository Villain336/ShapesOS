// Marketr — newsletter API: single sending domain (milestone 19).
// POST /api/newsletter/domains/[id]/verify?workspaceId= → re-check Resend verification
// DELETE /api/newsletter/domains/[id]?workspaceId= → remove (blocked if broadcasts reference it)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { refreshDomain } from "@/lib/newsletter/service";
import { requireWorkspaceEditor, workspacePort } from "../../_lib";

async function workspaceOf(userId: string, workspaceId: unknown) {
  if (typeof workspaceId !== "string" || !workspaceId) return null;
  return prisma.workspace.findFirst({
    where: { id: workspaceId, members: { some: { userId } } },
    select: { id: true },
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const ws = await workspaceOf(user.id, new URL(req.url).searchParams.get("workspaceId"));
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, ws.id);
  if (denied) return denied;
  const domain = await prisma.newsletterDomain.findFirst({ where: { id, workspaceId: ws.id } });
  if (!domain) return Response.json({ error: "Domain not found" }, { status: 404 });
  const portResult = await workspacePort(ws.id);
  if ("response" in portResult) return portResult.response;
  try {
    const updated = await refreshDomain(prisma, id, portResult.port);
    return Response.json({ status: updated.status, verifiedAt: updated.verifiedAt });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Verification check failed." }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const ws = await workspaceOf(user.id, new URL(req.url).searchParams.get("workspaceId"));
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, ws.id);
  if (denied) return denied;
  const used = await prisma.newsletterBroadcast.count({ where: { domainId: id } });
  if (used > 0) return Response.json({ error: "Domain has broadcasts — it can't be deleted (history is preserved)." }, { status: 400 });
  await prisma.newsletterDomain.deleteMany({ where: { id, workspaceId: ws.id } });
  return Response.json({ ok: true });
}
