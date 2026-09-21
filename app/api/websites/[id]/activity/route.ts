// Marketr — site change audit log API (milestone 7).
// GET /api/websites/[id]/activity?projectId=… → { entries }

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ownedSite } from "@/lib/connectors/source";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const site = await ownedSite(
    user.id,
    req.nextUrl.searchParams.get("projectId"),
    id,
  );
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  const entries = await prisma.fileChangeLog.findMany({
    where: { siteId: site.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return Response.json({
    entries: entries.map((e) => ({
      id: e.id,
      filePath: e.filePath,
      actor: e.actor,
      action: e.action,
      summary: e.summary,
      approvedBy: e.approvedBy,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}
