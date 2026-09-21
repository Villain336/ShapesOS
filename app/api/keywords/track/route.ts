// Marketr — toggle rank tracking on a saved keyword.
// POST /api/keywords/track  { keywordId, tracked: boolean }

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { keywordId?: string; tracked?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.keywordId || typeof body.tracked !== "boolean") {
    return Response.json(
      { error: "keywordId and tracked are required" },
      { status: 400 },
    );
  }

  const keyword = await prisma.keyword.findFirst({
    where: {
      id: body.keywordId,
      project: { workspace: accessibleWorkspaceWhere(user.id) },
    },
  });
  if (!keyword) {
    return Response.json({ error: "Keyword not found" }, { status: 404 });
  }
  if (!(await requireProjectRole(user.id, keyword.projectId, "editor"))) return forbidden();

  const updated = await prisma.keyword.update({
    where: { id: keyword.id },
    data: { tracked: body.tracked },
  });

  return Response.json({
    keyword: { id: updated.id, phrase: updated.phrase, tracked: updated.tracked },
  });
}
