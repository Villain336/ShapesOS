// Marketr — content engine: AI draft generation (spec §5 flow 3, step 2).
// POST /api/content/draft  { contentId }
//   → { contentItem, llm }
// Takes a ContentItem in "brief" status, sends the SERP-informed brief to the
// swappable LlmProvider (OpenAI-compatible when keys are configured,
// clearly-marked mock otherwise), and saves the draft (status "draft").
// Each draft increments the ai_words meter by the draft's word count.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getLlmProvider, llmStatus } from "@/lib/llm";
import { buildDraftPrompt } from "@/lib/content/draft";
import { wordCount, type ContentBrief } from "@/lib/content/brief";
import { recordUsage } from "@/lib/usage";

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
    include: { project: true, keyword: true },
  });
  if (!contentItem) {
    return Response.json({ error: "Content item not found" }, { status: 404 });
  }

  const brief = contentItem.outlineJson as ContentBrief | null;
  if (!brief?.keyword) {
    return Response.json(
      { error: "This item has no brief yet. Create a brief first." },
      { status: 400 },
    );
  }

  const llm = getLlmProvider();
  const prompt = buildDraftPrompt(brief);

  let draft: string;
  try {
    draft = await llm.generate(prompt);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Draft generation failed";
    return Response.json({ error: message }, { status: 502 });
  }

  const updated = await prisma.contentItem.update({
    where: { id: contentItem.id },
    data: { bodyMarkdown: draft, status: "draft" },
  });

  await recordUsage(contentItem.project.workspaceId, "ai_words", wordCount(draft)).catch(
    () => {},
  );

  return Response.json({
    contentItem: {
      id: updated.id,
      status: updated.status,
      keyword: contentItem.keyword?.phrase ?? brief.keyword,
    },
    draft,
    llm: llmStatus(),
  });
}
