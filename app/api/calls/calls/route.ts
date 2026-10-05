// Marketr — Calls API: call log.
// GET /api/calls/calls?numberId=&status=&leadId=&limit=&cursor=

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { intQuery, parseQuery, z } from "@/lib/api/validate";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const sp = new URL(req.url).searchParams;
  const where: Prisma.CallWhereInput = { workspaceId: workspace.id };
  const numberId = sp.get("numberId");
  if (numberId) where.numberId = numberId;
  const status = sp.get("status");
  if (status) where.status = status;
  const leadId = sp.get("leadId");
  if (leadId) where.leadId = leadId;
  const limitQuery = parseQuery(z.object({ limit: intQuery(50, 1, 200) }), sp);
  if (!limitQuery.ok) return limitQuery.error;
  const limit = limitQuery.data.limit;
  const cursor = sp.get("cursor");

  const calls = await prisma.call.findMany({
    where,
    orderBy: { startedAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      number: { select: { e164: true, friendlyName: true, campaign: true } },
      lead: { select: { id: true, name: true, phone: true } },
    },
  });
  const hasMore = calls.length > limit;
  const rows = hasMore ? calls.slice(0, limit) : calls;
  return Response.json({
    calls: rows,
    nextCursor: hasMore ? rows[rows.length - 1].id : null,
  });
}
