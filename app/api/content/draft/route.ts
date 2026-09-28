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
// Phase 13B: fail-closed style-rule enforcement on generated drafts +
// content-memory recording.
import {
  enforceStyleRules,
  StyleRuleBlockedError,
} from "@/lib/intelligence/enforce";
import { recordContent } from "@/lib/intelligence/company/content-record";
import {
  captureEpisode,
  recordFeedback,
  findLatestDraftEpisode,
} from "@/lib/agents/learning/capture";

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

  // Phase 13B: fail-closed style-rule check BEFORE the draft is saved or
  // returned. A severity=block violation refuses delivery (422) — the
  // violating draft never reaches the user.
  try {
    await enforceStyleRules(draft, contentItem.project.workspaceId);
  } catch (err) {
    if (err instanceof StyleRuleBlockedError) {
      return Response.json(
        {
          error: "Draft blocked by a style rule",
          violations: err.violations,
        },
        { status: 422 },
      );
    }
    // Infra failure in the checker: degrade open (see agent.ts note).
  }

  const updated = await prisma.contentItem.update({
    where: { id: contentItem.id },
    data: { bodyMarkdown: draft, status: "draft" },
  });

  // Phase 13B: if the item already carried an agent draft, this generation
  // is a REGENERATION — look up the previous draft's episode for the signal.
  const hadDraft =
    contentItem.status === "draft" || (contentItem.bodyMarkdown ?? "").trim().length > 0;
  const prevDraft = hadDraft
    ? await findLatestDraftEpisode(contentItem.project.workspaceId, contentItem.id)
    : null;

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

  // Phase 13B: content memory — index the generated draft so the company
  // intelligence layer can answer "we already ran this angle" later.
  // bodyRef points at the artifact; the body itself is never duplicated.
  recordContent(contentItem.project.workspaceId, {
    kind: "blog_post",
    title: contentItem.keyword?.phrase ?? brief.keyword,
    bodyRef: `content_item:${updated.id}`,
    angle: brief.h1,
  }).catch(() => {});

  // Phase 13B: episode capture — the full draft rides in refs.draftFull so
  // the editor-save hook can diff user edits against it. The episode id is
  // returned so the UI can attach thumbs (explicit_up/down) to this draft.
  // Fail-soft: capture never breaks draft generation.
  const episodeId = await captureEpisode({
    workspaceId: contentItem.project.workspaceId,
    agentId: "content-brief",
    promptSummary: `Draft article for keyword "${brief.keyword}"`,
    outputSummary: draft,
    outcome: hadDraft ? "draft_regenerated" : "draft_generated",
    refs: {
      contentItemId: contentItem.id,
      keyword: brief.keyword,
      draftFull: draft,
    },
  });
  if (hadDraft && prevDraft) {
    await recordFeedback({
      workspaceId: contentItem.project.workspaceId,
      episodeId: prevDraft.id,
      agentId: "content-brief",
      kind: "regenerated",
      signal: { reason: "user_regenerated_draft", newEpisodeId: episodeId },
    });
  }

  return Response.json({
    contentItem: {
      id: updated.id,
      status: updated.status,
      keyword: contentItem.keyword?.phrase ?? brief.keyword,
    },
    draft,
    llm: llmStatus(),
    episodeId,
  });
}
