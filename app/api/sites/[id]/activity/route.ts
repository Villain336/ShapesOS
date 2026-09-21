// Marketr — IDE change audit log API (milestone 6).
// GET /api/sites/[id]/activity?projectId=… → { entries }
// Newest first. This is the accountability view for the supervised rung:
// every manual save, every AI proposal, every approved application.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ownedConnection } from "@/lib/sitefiles/api";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const connection = await ownedConnection(user.id, sp.get("projectId"), id);
  if (!connection) {
    return Response.json({ error: "Connection not found" }, { status: 404 });
  }

  const entries = await prisma.fileChangeLog.findMany({
    where: { projectId: connection.projectId },
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
      createdAt: e.createdAt,
    })),
  });
}
