// Marketr — Calls API: bookings list.
// GET /api/calls/bookings?pageId=&status=&limit=&cursor=

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const sp = new URL(req.url).searchParams;
  const where: Prisma.BookingWhereInput = { workspaceId: workspace.id };
  const pageId = sp.get("pageId");
  if (pageId) where.pageId = pageId;
  const status = sp.get("status");
  if (status) where.status = status;
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 50) || 50, 1), 200);
  const cursor = sp.get("cursor");

  const bookings = await prisma.booking.findMany({
    where,
    orderBy: { startAt: "asc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      page: { select: { title: true, slug: true } },
      lead: { select: { id: true, name: true } },
    },
  });
  const hasMore = bookings.length > limit;
  const rows = hasMore ? bookings.slice(0, limit) : bookings;
  return Response.json({
    bookings: rows,
    nextCursor: hasMore ? rows[rows.length - 1].id : null,
  });
}
