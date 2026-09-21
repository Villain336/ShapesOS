// Marketr — bulk-approve issues (milestone 10).
// POST /api/websites/[id]/issues/approve-all { projectId, severity?, category? }
// Approves every open, auto-fixable issue matching the filters.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { readJsonBody } from "@/lib/sitefiles/api";
import { ownedSite } from "@/lib/connectors/source";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJsonBody<{ projectId?: string; severity?: string; category?: string }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  const result = await prisma.siteIssue.updateMany({
    where: {
      siteId: site.id,
      status: "open",
      autoFixable: true,
      ...(body?.severity ? { severity: body.severity as never } : {}),
      ...(body?.category ? { category: body.category } : {}),
    },
    data: { status: "approved", approvedBy: user.id, approvedAt: new Date() },
  });
  return Response.json({ ok: true, approved: result.count });
}
