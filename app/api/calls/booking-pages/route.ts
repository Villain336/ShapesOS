// Marketr — Calls API: booking pages.
// GET  /api/calls/booking-pages → list (workspace-scoped)
// POST /api/calls/booking-pages (editor+) → create; returns the page AND the
//   one-time public token (shown once — only the hash is stored).

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { BookingSettingsSchema, hashBookingToken, newBookingToken } from "@/lib/calls/booking";

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  slug: z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, hyphens"),
  settings: BookingSettingsSchema.optional(),
});

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const pages = await prisma.bookingPage.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, slug: true, title: true, description: true, enabled: true,
      settings: true, createdAt: true, updatedAt: true,
      _count: { select: { bookings: true } },
    },
  });
  return Response.json({ pages });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;

  const existing = await prisma.bookingPage.findUnique({ where: { slug: d.slug } });
  if (existing) return Response.json({ error: "Slug already taken" }, { status: 409 });

  const { token, prefix } = newBookingToken();
  const page = await prisma.bookingPage.create({
    data: {
      workspaceId: workspace.id,
      slug: d.slug,
      tokenHash: hashBookingToken(token),
      title: d.title,
      description: d.description ?? null,
      settings: (d.settings ?? {}) as object,
    },
  });
  return Response.json({ page, token, tokenPrefix: prefix }, { status: 201 });
}
