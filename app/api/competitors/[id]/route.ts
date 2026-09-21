// Marketr — competitor removal.
// DELETE /api/competitors/[id] → { ok: true }

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const competitor = await prisma.competitor.findFirst({
    where: { id, project: { workspace: { ownerUserId: user.id } } },
  });
  if (!competitor) {
    return Response.json({ error: "Competitor not found" }, { status: 404 });
  }

  await prisma.competitor.delete({ where: { id } });
  return Response.json({ ok: true });
}
