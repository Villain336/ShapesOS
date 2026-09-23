// Marketr — content engine: AI draft generation (spec §5 flow 3, step 2).
// POST /api/content/draft  { contentId }
//   → { contentItem, llm }
// Takes a ContentItem in "brief" status, sends the SERP-informed brief to the
// swappable LlmProvider (OpenAI-compatible when keys are configured,
// clearly-marked mock otherwise), and saves the draft (status "draft").
// Each draft increments the ai_words meter by the draft's word count.

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import {
  getLlmProviderFor,
  llmStatus,
  WORKLOAD_MAX_TOKENS,
} from "@/lib/llm";
import { buildDraftPrompt } from "@/lib/content/draft";
import { wordCount, type ContentBrief } from "@/lib/content/brief";
import { recordUsage } from "@/lib/usage";
import { meter } from "@/lib/metering/service";

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
      project: { workspace: accessibleWorkspaceWhere(user.id) },
    },
    include: { project: true, keyword: true },
  });
  if (!contentItem) {
    return Response.json({ error: "Content item not found" }, { status: 404 });
  }
  if (!(await requireProjectRole(user.id, contentItem.projectId, "editor"))) return forbidden();

  const brief = contentItem.outlineJson as ContentBrief | null;
  if (!brief?.keyword) {
    return Response.json(
      { error: "This item has no brief yet. Create a brief first." },
      { status: 400 },
    );
  }

  // Phase D: client-facing draft → "copy" workload (claude-haiku-4-5).
  const llm = getLlmProviderFor("copy");
  const prompt = buildDraftPrompt(brief);

  let draft: string;
  try {
    draft = await llm.generate(prompt, {
      maxTokens: WORKLOAD_MAX_TOKENS.copy,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Draft generation failed";
    return Response.json({ error: message }, { status: 502 });
  }

  const updated = await prisma.contentItem.update({
    where: { id: contentItem.id },
    data: { bodyMarkdown: draft, status: "draft" },
  });

  // Phase C gaps (G1): ledger one ai_article per generated draft. The key
  // binds the pre-generation updatedAt: a retry after a failed generation
  // reuses the key (no double charge); a genuine regeneration after success
  // sees a new updatedAt and charges again.
  await meter({
    workspaceId: contentItem.project.workspaceId,
    projectId: contentItem.projectId,
    action: "ai_article",
    idempotencyKey: `aiarticle:${contentItem.id}:${contentItem.updatedAt.getTime()}`,
    evidenceRef: `ai-article:${contentItem.id}`,
  }).catch(() => {});

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
