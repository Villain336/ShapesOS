// Marketr — site connection delete API (milestone 6).
// DELETE /api/sites/[id]?projectId=…

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ownedConnection } from "@/lib/sitefiles/api";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const connection = await ownedConnection(
    user.id,
    req.nextUrl.searchParams.get("projectId"),
    id,
  );
  if (!connection) {
    return Response.json({ error: "Connection not found" }, { status: 404 });
  }
  await prisma.siteConnection.delete({ where: { id: connection.id } });
  return Response.json({ ok: true });
}
