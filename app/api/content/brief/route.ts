// Marketr — content engine: brief generator (spec §5 flow 3, step 1).
// POST /api/content/brief  { projectId, keywordId }
//   → { contentItem, brief, provider }
// Fetches the top-10 SERP for a saved keyword, builds a structured brief
// with buildBrief(), and persists it to ContentItem (status "brief").
// Each brief increments the serp_calls meter (best-effort).

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { providerStatus } from "@/lib/providers";
import { pullSerp } from "@/lib/serp/pull";
import { buildBrief, type ContentBrief } from "@/lib/content/brief";
import { recordUsage } from "@/lib/usage";
import { meter } from "@/lib/metering/service";

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
      project: { id: body.projectId, workspace: accessibleWorkspaceWhere(user.id) },
    },
    include: { project: true },
  });
  if (!keyword) {
    return Response.json({ error: "Keyword not found" }, { status: 404 });
  }
  if (!(await requireProjectRole(user.id, body.projectId, "editor"))) return forbidden();

  let brief: ContentBrief;
  try {
    // Internal SERP pull via the shared un-metered helper (T14): the brief
    // charges "content_brief" once per ContentItem below — never
    // "serp_analysis" for this pull.
    const serp = (await pullSerp({
      keyword: keyword.phrase,
      depth: 10,
    })).snapshot;
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

  // Phase C gaps (G1): ledger one content_brief per generated brief. The
  // contentItem row is the domain row — a new brief always creates a new
  // item, so the key is unique per brief and stable across retries.
  await meter({
    workspaceId: keyword.project.workspaceId,
    projectId: keyword.project.id,
    action: "content_brief",
    idempotencyKey: `contentbrief:${contentItem.id}`,
    evidenceRef: `content-brief:${contentItem.id}`,
  }).catch(() => {});

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
