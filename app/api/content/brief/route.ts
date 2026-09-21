// Marketr — content engine: brief generator (spec §5 flow 3, step 1).
// POST /api/content/brief  { projectId, keywordId }
//   → { contentItem, brief, provider }
// Fetches the top-10 SERP for a saved keyword, builds a structured brief
// with buildBrief(), and persists it to ContentItem (status "brief").
// Each brief increments the serp_calls meter (best-effort).

import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getSeoProvider, providerStatus } from "@/lib/providers";
import { buildBrief, type ContentBrief } from "@/lib/content/brief";
import { recordUsage } from "@/lib/usage";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { projectId?: string; keywordId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const keyword = await prisma.keyword.findFirst({
    where: {
      id: body.keywordId,
      project: { id: body.projectId, workspace: { ownerUserId: user.id } },
    },
    include: { project: true },
  });
  if (!keyword) {
    return Response.json({ error: "Keyword not found" }, { status: 404 });
  }

  const provider = getSeoProvider();

  let brief: ContentBrief;
  try {
    const serp = await provider.serpResults({
      keyword: keyword.phrase,
      depth: 10,
    });
    brief = buildBrief(keyword.phrase, keyword.intent, serp);
    await recordUsage(keyword.project.workspaceId, "serp_calls", 1).catch(
      () => {},
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Brief generation failed";
    return Response.json({ error: message }, { status: 502 });
  }

  const contentItem = await prisma.contentItem.create({
    data: {
      projectId: keyword.project.id,
      keywordId: keyword.id,
      status: "brief",
      outlineJson: brief as unknown as Prisma.InputJsonValue,
    },
  });

  return Response.json({
    contentItem: {
      id: contentItem.id,
      status: contentItem.status,
      keyword: keyword.phrase,
    },
    brief,
    provider: providerStatus(),
  });
}
