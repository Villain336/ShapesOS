// Marketr — Calls API: one booking page.
// GET    /api/calls/booking-pages/[id]
// PATCH  /api/calls/booking-pages/[id] (editor+) → { title?, description?, enabled?, settings? }
// DELETE /api/calls/booking-pages/[id] (editor+)

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { BookingSettingsSchema } from "@/lib/calls/booking";

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
  settings: BookingSettingsSchema.optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { id } = await ctx.params;

  const page = await prisma.bookingPage.findFirst({
    where: { id, workspaceId: workspace.id },
    select: {
      id: true, slug: true, title: true, description: true, enabled: true,
      settings: true, createdAt: true, updatedAt: true,
      _count: { select: { bookings: true } },
    },
  });
  if (!page) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ page });
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
  const count = await prisma.bookingPage.updateMany({
    where: { id, workspaceId: workspace.id },
    data: {
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.settings !== undefined ? { settings: parsed.data.settings as object } : {}),
    },
  });
  if (count.count === 0) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await ctx.params;

  const count = await prisma.bookingPage.deleteMany({ where: { id, workspaceId: workspace.id } });
  if (count.count === 0) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}
