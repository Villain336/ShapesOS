// Marketr — save researched keywords to a named list.
// POST /api/keywords/save  { projectId, list, ideas: KeywordIdea[] }
// Persists into the Keyword table (spec §6), deduped on (projectId, phrase).

import type { NextRequest } from "next/server";
import type { KeywordIntent } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { recordUsage } from "@/lib/usage";
import type { KeywordIdea } from "@/lib/providers/types";

const INTENT_VALUES: KeywordIntent[] = [
  "informational",
  "navigational",
  "commercial",
  "transactional",
  "unknown",
];

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { projectId?: string; list?: string; ideas?: KeywordIdea[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const project = await prisma.project.findFirst({
    where: { id: body.projectId, workspace: { ownerUserId: user.id } },
    include: { workspace: true },
  });
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const list = String(body.list ?? "").trim() || "Saved keywords";
  const ideas = Array.isArray(body.ideas) ? body.ideas : [];
  if (ideas.length === 0) {
    return Response.json({ error: "No ideas to save" }, { status: 400 });
  }

  const data = ideas
    .filter((i) => i && typeof i.phrase === "string" && i.phrase.trim())
    .map((i) => ({
      projectId: project.id,
      phrase: i.phrase.trim(),
      volume: typeof i.volume === "number" ? Math.round(i.volume) : null,
      difficulty: typeof i.difficulty === "number" ? i.difficulty : null,
      cpc: typeof i.cpc === "number" ? i.cpc : null,
      intent: (INTENT_VALUES.includes(i.intent as KeywordIntent)
        ? i.intent
        : "unknown") as KeywordIntent,
      list,
    }));

  const result = await prisma.keyword.createMany({
    data,
    skipDuplicates: true,
  });

  await recordUsage(project.workspaceId, "tracked_keywords", result.count).catch(
    () => {},
  );

  return Response.json({ saved: result.count, list }, { status: 201 });
}
