// Marketr — R3 enrollment list API.
// GET /api/nurture/enrollments?sequenceId=&status=&q=&limit=

import { prisma } from "@/lib/prisma";
import { nurtureCtx } from "../_lib";
import { intQuery, parseQuery, z } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

const ENROLL_STATUSES = ["active", "paused", "completed", "unenrolled", "bounced"] as const;

export async function GET(req: Request) {
  const ctx = await nurtureCtx();
  if (ctx instanceof Response) return ctx;
  const sp = new URL(req.url).searchParams;

  const where: Record<string, unknown> = { workspaceId: ctx.workspaceId };
  const sequenceId = sp.get("sequenceId");
  if (sequenceId) where.sequenceId = sequenceId;
  const status = sp.get("status");
  if (status && (ENROLL_STATUSES as readonly string[]).includes(status)) where.status = status;
  const q = sp.get("q")?.trim();
  if (q) {
    where.lead = {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { company: { contains: q, mode: "insensitive" } },
      ],
    };
  }
  const limitQuery = parseQuery(z.object({ limit: intQuery(100, 1, 200) }), sp);
  if (!limitQuery.ok) return limitQuery.error;
  const limit = limitQuery.data.limit;

  const [enrollments, total] = await Promise.all([
    prisma.sequenceEnrollment.findMany({
      where: where as never,
      include: {
        sequence: { select: { id: true, name: true, status: true } },
        lead: { select: { id: true, name: true, email: true, phone: true, company: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    }),
    prisma.sequenceEnrollment.count({ where: where as never }),
  ]);
  return Response.json({ enrollments, total });
}
