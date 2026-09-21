// Marketr — content engine: mark published (spec §5 flow 3).
// POST /api/content/publish  { contentId }  → { contentItem }
// Marks the item "published". No actual CMS publishing in this milestone —
// the WordPress publish step belongs to the fix-agent phase (out of scope).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { contentId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contentItem = await prisma.contentItem.findFirst({
    where: {
      id: body.contentId,
      project: { workspace: { ownerUserId: user.id } },
    },
  });
  if (!contentItem) {
    return Response.json({ error: "Content item not found" }, { status: 404 });
  }

  const updated = await prisma.contentItem.update({
    where: { id: contentItem.id },
    data: { status: "published" },
  });

  return Response.json({
    contentItem: { id: updated.id, status: updated.status },
  });
}
