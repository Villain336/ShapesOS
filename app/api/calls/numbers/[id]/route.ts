// Marketr — Calls API: one tracking number.
// GET    /api/calls/numbers/[id]
// PATCH  /api/calls/numbers/[id] (editor+) → { friendlyName?, campaign? }
// DELETE /api/calls/numbers/[id] (editor+) → release upstream, mark released

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { getProvider } from "@/lib/calls/provider";

const PatchSchema = z.object({
  friendlyName: z.string().trim().max(64).nullable().optional(),
  campaign: z.string().trim().max(160).nullable().optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { id } = await ctx.params;

  const number = await prisma.callNumber.findFirst({
    where: { id, workspaceId: workspace.id },
    include: { _count: { select: { calls: true } } },
  });
  if (!number) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ number });
}

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
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const number = await prisma.callNumber.updateMany({
    where: { id, workspaceId: workspace.id },
    data: {
      ...(parsed.data.friendlyName !== undefined ? { friendlyName: parsed.data.friendlyName } : {}),
      ...(parsed.data.campaign !== undefined ? { campaign: parsed.data.campaign } : {}),
    },
  });
  if (number.count === 0) return Response.json({ error: "Not found" }, { status: 404 });
  const updated = await prisma.callNumber.findUnique({ where: { id } });
  return Response.json({ number: updated });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await ctx.params;

  const number = await prisma.callNumber.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!number) return Response.json({ error: "Not found" }, { status: 404 });
  if (number.status === "released") return Response.json({ number });

  try {
    await getProvider().releaseNumber(number.e164);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Release failed" }, { status: 502 });
  }
  const updated = await prisma.callNumber.update({
    where: { id },
    data: { status: "released" },
  });
  return Response.json({ number: updated });
}
