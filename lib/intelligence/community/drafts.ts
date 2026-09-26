// Marketr — Phase 10 M8: draft generation + approval-inbox queueing.
//
// DRAFT-FIRST, ALWAYS. This module drafts community replies with the LLM
// (lib/llm router, "copy" workload — the text goes out under the user's
// name), gates every draft through tasteCheck(), and queues passing drafts
// in the Phase 9 approval inbox as mission_approvals rows
// (action "community_reply_draft", Tier 2) — the EXACT item schema the
// inbox reads. There is no parallel inbox and no publishing code path
// anywhere in this module; the human edits and posts NATIVELY.
//
// No astroturfing, no fake engagement: drafts are written in the user's
// voice (one account, honest identity) and never invent experience.

import { getLlmProviderFor } from "@/lib/llm";
import { createPrismaMissionApprovalStore } from "@/lib/authority/mission-approvals-db";
import type { MissionApprovalStore } from "@/lib/authority/executor";
import { tasteCheck, type TasteCheckOptions } from "./taste";
import {
  COMMUNITY_DRAFT_ACTION,
  COMMUNITY_DRAFT_TIER,
  COMMUNITY_TASTE_REJECTED_EVENT,
  type ExpertiseProfile,
  type QueuedDraft,
  type ScoredOpportunity,
  type TasteCheckResult,
  type TasteRejected,
} from "./types";

export interface DraftDeps {
  /** Override the LLM generator (tests). Default: lib/llm "copy" workload. */
  generate?: (prompt: string) => Promise<string>;
  /** Override the approval store (tests). Default: Prisma store (production). */
  approvalStore?: MissionApprovalStore;
  /** Taste options (per-source length caps). */
  taste?: TasteCheckOptions;
  /** Called when a draft fails taste (default: console.warn). */
  onTasteReject?: (rejected: TasteRejected) => void;
}

function identityLine(profile: ExpertiseProfile): string {
  const bits: string[] = [];
  if (profile.trackedKeywords.length > 0) {
    bits.push(`their working expertise: ${profile.trackedKeywords.slice(0, 8).join(", ")}`);
  }
  if (profile.projectDomains.length > 0) {
    bits.push(`their site(s): ${profile.projectDomains.slice(0, 3).join(", ")}`);
  }
  return bits.length > 0 ? bits.join("; ") : "a practitioner in this space";
}

function draftPrompt(opportunity: ScoredOpportunity, profile: ExpertiseProfile): string {
  return [
    "Write a short reply to this forum thread, as a knowledgeable practitioner (first person).",
    "",
    `Thread title: ${opportunity.title}`,
    `Thread excerpt: ${opportunity.text.slice(0, 1200)}`,
    `Why this thread matters to them: ${opportunity.relevanceReason}`,
    `Who they are: ${identityLine(profile)}`,
    "",
    "Rules — a real person with context wrote this, not a bot:",
    "- Maximum 120 words. Short, specific, conversational.",
    "- Answer the actual question or add one concrete, specific point. No generic advice.",
    "- Never mention being an AI. Never use emojis.",
    "- No marketing language, no hype, no sycophantic opener like 'Great question!'.",
    "- Do not pitch a product or company. If their own experience is relevant, mention it plainly in one clause.",
    "- At most one link, only if it directly answers something asked.",
    "- Output ONLY the reply text, no preamble, no quotes around it.",
  ].join("\n");
}

/**
 * Generate a draft reply via the LLM. One retry with the taste failures
 * appended when the first attempt fails taste; after that the draft dies
 * (returned with ok=false — the caller logs it, never queues it).
 */
export async function generateDraftText(
  opportunity: ScoredOpportunity,
  profile: ExpertiseProfile,
  deps: DraftDeps = {},
): Promise<{ draft: string; taste: TasteCheckResult }> {
  const generate = deps.generate ?? ((prompt: string) =>
    getLlmProviderFor("copy").generate(prompt, { maxTokens: 400 }));
  const tasteOpts = deps.taste ?? {};

  const first = (await generate(draftPrompt(opportunity, profile))).trim();
  let taste = tasteCheck(first, tasteOpts);
  if (taste.ok) return { draft: first, taste };

  const retry = (
    await generate(
      `${draftPrompt(opportunity, profile)}\n\n` +
        `The previous attempt failed these checks — fix them: ${taste.failures.join("; ")}. ` +
        `Output ONLY the revised reply text.`,
    )
  ).trim();
  taste = tasteCheck(retry, tasteOpts);
  return { draft: retry, taste };
}

export interface QueueDraftInput {
  workspaceId: string;
  createdBy: string;
  opportunity: ScoredOpportunity;
  /** Pre-generated draft (skips LLM generation — used by tests/UI preview flows). */
  draft?: string;
  profile?: ExpertiseProfile;
}

export interface QueueDraftResult {
  queued: boolean;
  approvalId: string | null;
  taste: TasteCheckResult;
  draft: string | null;
}

/**
 * The ONLY sink in this module: a Phase 9 approval inbox item. Drafts that
 * fail tasteCheck() never reach the inbox — they are reported via
 * onTasteReject and (in production wiring) logged to the approval event
 * trail as community.taste_rejected. missionId is null: community drafts
 * are workspace-level, not mission-bound.
 *
 * bindingJson key ORDER matters: the inbox's payloadSummary renders the
 * first 4 keys, so source → thread → reason → draft come first.
 */
export async function queueCommunityDraft(
  input: QueueDraftInput,
  deps: DraftDeps = {},
): Promise<QueueDraftResult> {
  const { workspaceId, createdBy, opportunity } = input;
  if (!workspaceId) throw new Error("queueCommunityDraft: workspaceId is required.");

  let draft = input.draft?.trim() ?? "";
  let taste: TasteCheckResult;
  if (!draft && input.profile) {
    const gen = await generateDraftText(opportunity, input.profile, deps);
    draft = gen.draft;
    taste = gen.taste;
  } else if (draft) {
    taste = tasteCheck(draft, deps.taste ?? {});
  } else {
    throw new Error("queueCommunityDraft: provide draft or profile for generation.");
  }

  if (!taste.ok) {
    const rejected: TasteRejected = { opportunity, draft, failures: taste.failures };
    if (deps.onTasteReject) deps.onTasteReject(rejected);
    else {
      console.warn(
        `[m8] taste check rejected draft for ${opportunity.url}: ${taste.failures.join("; ")}`,
      );
    }
    return { queued: false, approvalId: null, taste, draft };
  }

  const store = deps.approvalStore ?? createPrismaMissionApprovalStore();
  const bindingJson: Record<string, unknown> = {
    source: opportunity.source,
    thread: opportunity.title,
    reason: opportunity.relevanceReason,
    draft,
    threadUrl: opportunity.url,
    signal: opportunity.signals.join(","),
    matchedKeywords: opportunity.matchedKeywords,
    externalId: opportunity.externalId,
    author: opportunity.author ?? null,
    feedName: opportunity.feedName ?? null,
  };
  const approval = await store.create({
    workspaceId,
    missionId: null,
    action: COMMUNITY_DRAFT_ACTION,
    tier: COMMUNITY_DRAFT_TIER,
    bindingJson,
    createdBy,
  });
  return { queued: true, approvalId: approval.id, taste, draft };
}

/** Event-trail action constant for taste rejections (production wiring
 *  appends these via appendApprovalEvent on a workspace-level anchor). */
export { COMMUNITY_TASTE_REJECTED_EVENT };
