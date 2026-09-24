// Marketr — Calls API: one booking.
// GET   /api/calls/bookings/[id]
// PATCH /api/calls/bookings/[id] (editor+) → { status?, remindersOptedOut? }
//   status transitions: scheduled → cancelled | completed. Cancelling marks
//   pending reminders skipped_opt_out (via recordOptOut).

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { recordOptOut } from "@/lib/calls/reminders";

const PatchSchema = z.object({
  status: z.enum(["scheduled", "cancelled", "completed"]).optional(),
  remindersOptedOut: z.boolean().optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { id } = await ctx.params;

  const booking = await prisma.booking.findFirst({
    where: { id, workspaceId: workspace.id },
    include: {
      page: { select: { title: true, slug: true } },
      lead: { select: { id: true, name: true, email: true, phone: true } },
      reminders: { orderBy: { dueAt: "asc" } },
    },
  });
  if (!booking) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ booking });
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

  const existing = await prisma.booking.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  if (parsed.data.status === "cancelled" && existing.status === "scheduled") {
    await recordOptOut(id, workspace.id);
  }
  const updated = await prisma.booking.update({
    where: { id },
    data: {
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      ...(parsed.data.remindersOptedOut !== undefined
        ? { remindersOptedOut: parsed.data.remindersOptedOut }
        : {}),
    },
  });
  return Response.json({ booking: updated });
}
