// Marketr — Phase 10 M4: AI summaries over diffs.
//
// Each detected change gets:
//   - semantic_summary   — what changed (pricing, positioning, new offer, …)
//   - why_it_matters     — tied to the user's tracked keywords (keyword
//                          overlap via the Phase 1 competitor-gap helpers in
//                          lib/competitors.ts: normalizePhrase)
//   - recommended_response — PROSE + a suggested Phase 9 mission template id
//                          (validated against the real MISSION_TEMPLATES list
//                          — never invented).
//
// Via the lib/llm router on the "bulk" workload (cheap model, 2048-token
// ceiling). PROPOSE-ONLY (spec §4.3): this module writes summaries to the
// change row and stops. Actions go through the Phase 9 approval executor —
// nothing here calls it, ever.

import type { TxClient } from "@/lib/substrate/graph/rls";
import { WORKLOAD_MAX_TOKENS } from "@/lib/llm";
import { getLlmProviderForWorkspace } from "@/lib/llm/workspace";
import { normalizePhrase } from "@/lib/competitors";
import { listTemplates } from "@/lib/missions/templates";
import type { ChangeCategory } from "./types";
import { classifySitemapUrl } from "./classify";

export interface SummarizeDeps {
  tx: TxClient;
  changeId: string;
  workspaceId: string;
  projectId: string;
  competitorDomain: string;
  url: string;
  changeType: string;
  /** Present for tracked-URL diffs (old → new normalized text). */
  diffText?: { before: string; after: string };
  maxKeywords?: number;
}

export interface ChangeSummary {
  semanticSummary: string;
  whyItMatters: string;
  recommendedResponse: string;
  /** Real Phase 9 mission template id, or null when none fits. */
  missionTemplateId: string | null;
  category: ChangeCategory;
  overlappingKeywords: string[];
  /** "llm" when the router served a real model, "heuristic" fallback. */
  source: "llm" | "heuristic";
}

/** Map a change category onto an existing Phase 9 mission template id.
 *  The mapping is a documented heuristic — the human reviews the proposal
 *  in the approval inbox before anything is created. Returns null when no
 *  template is a sensible fit. */
export function routeToMissionTemplate(category: ChangeCategory): string | null {
  const templates = listTemplates();
  const byId = new Map(templates.map((t) => [t.id, t]));
  const pick = (id: string) => (byId.has(id) ? id : null);
  switch (category) {
    case "pricing":
      return pick("professional-services.proposal-win-rate") ?? pick("saas.trial-to-paid");
    case "offer":
      return pick("ecommerce.cart-recovery") ?? pick("saas.trial-starts");
    case "positioning":
      return pick("local-services.gbp-visibility") ?? pick("saas.trial-starts");
    case "content":
      return pick("home-services.booked-job-growth") ?? pick("saas.trial-starts");
    case "reviews":
      return pick("home-services.review-velocity");
    case "seo":
      return pick("local-services.gbp-visibility");
    default:
      return null;
  }
}

/** Tracked-keyword overlap: which of the project's keywords appear in the
 *  changed text/URL (Phase 1 gap-module phrase normalization). */
export async function keywordOverlap(
  tx: TxClient,
  projectId: string,
  text: string,
  url: string,
  max = 5,
): Promise<string[]> {
  const keywords = await tx.keyword.findMany({
    where: { projectId },
    select: { phrase: true },
    take: 500,
  });
  const haystack = normalizePhrase(`${url} ${text}`);
  const hits: string[] = [];
  for (const k of keywords) {
    const phrase = normalizePhrase(k.phrase);
    if (phrase.length >= 3 && haystack.includes(phrase)) {
      hits.push(k.phrase);
      if (hits.length >= max) break;
    }
  }
  return hits;
}

function heuristicSummary(
  deps: SummarizeDeps,
  category: ChangeCategory,
  overlapping: string[],
  missionTemplateId: string | null,
): ChangeSummary {
  const what =
    deps.changeType === "page_added"
      ? `New page published: ${deps.url}`
      : deps.changeType === "page_removed"
        ? `Page removed from sitemap: ${deps.url}`
        : `Content changed on ${deps.url} (${deps.changeType.replace(/_/g, " ")})`;
  return {
    semanticSummary: `${what}. Category signals: ${category}. (Heuristic summary — LLM unavailable; review the page directly.)`,
    whyItMatters:
      overlapping.length > 0
        ? `Overlaps your tracked keywords: ${overlapping.join(", ")}. A competitor move on keywords you track deserves a look before they consolidate.`
        : `No direct overlap with your tracked keywords. Monitor for pattern (new ${category} cluster) rather than immediate response.`,
    recommendedResponse: missionTemplateId
      ? `Proposed (needs your approval — nothing is created automatically): draft a Mission from Phase 9 template "${missionTemplateId}" to answer this ${category} move.`
      : `Proposed (needs your approval): log this ${category} change in the weekly review; no mission template fits cleanly, so respond manually.`,
    missionTemplateId,
    category,
    overlappingKeywords: overlapping,
    source: "heuristic",
  };
}

function buildPrompt(deps: SummarizeDeps, overlapping: string[], category: ChangeCategory): string {
  const diffBlock = deps.diffText
    ? `BEFORE (normalized excerpt):\n${deps.diffText.before.slice(0, 1500)}\n\nAFTER (normalized excerpt):\n${deps.diffText.after.slice(0, 1500)}`
    : `No before/after text available (sitemap-level event). URL: ${deps.url}`;
  return `You are a competitive-intelligence analyst for an SEO/marketing team. A competitor changed their website. Summarize the change semantically — NOT a pixel diff.

Competitor: ${deps.competitorDomain}
Change type: ${deps.changeType}
Detected category signals: ${category}
User's tracked keywords overlapping this change: ${overlapping.length ? overlapping.join(", ") : "(none)"}

${diffBlock}

Reply with STRICT JSON only (no markdown fences), exactly these keys:
{
  "semantic_summary": "1-2 sentences: what changed in business terms (pricing, positioning, new offer, new content cluster, removed page, ...)",
  "why_it_matters": "1-2 sentences: why this matters given the keyword overlap above (or why it doesn't, if none)",
  "recommended_response": "1-2 sentences: concrete next step phrased as a PROPOSAL for a human to approve (never claim anything was done)"
}`;
}

function parseSummaryJson(raw: string): { semantic_summary: string; why_it_matters: string; recommended_response: string } | null {
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    if (
      typeof obj.semantic_summary === "string" &&
      typeof obj.why_it_matters === "string" &&
      typeof obj.recommended_response === "string"
    ) {
      return {
        semantic_summary: obj.semantic_summary.slice(0, 2000),
        why_it_matters: obj.why_it_matters.slice(0, 2000),
        recommended_response: obj.recommended_response.slice(0, 2000),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Summarize one detected change and persist the summary onto its row.
 *  Never throws the caller's job — falls back to the heuristic summary. */
export async function summarizeChange(deps: SummarizeDeps): Promise<ChangeSummary> {
  const haystack = `${deps.url}\n${deps.diffText?.after ?? ""}`;
  const category = deps.diffText
    ? classifySitemapUrl(haystack)
    : classifySitemapUrl(deps.url);
  const overlapping = await keywordOverlap(
    deps.tx,
    deps.projectId,
    deps.diffText?.after ?? "",
    deps.url,
    deps.maxKeywords ?? 5,
  );
  const missionTemplateId = routeToMissionTemplate(category);

  let summary: ChangeSummary | null = null;
  try {
    // Phase 15: the workspace's own model key when it has one; metered by tokens.
    const provider = await getLlmProviderForWorkspace("bulk", { workspaceId: deps.workspaceId, projectId: deps.projectId });
    if (provider.isConfigured()) {
      const raw = await provider.generate(buildPrompt(deps, overlapping, category), {
        maxTokens: WORKLOAD_MAX_TOKENS.bulk,
      });
      const parsed = parseSummaryJson(raw);
      if (parsed) {
        summary = {
          semanticSummary: parsed.semantic_summary,
          whyItMatters: parsed.why_it_matters,
          recommendedResponse: `${parsed.recommended_response} (Suggested template: ${missionTemplateId ?? "none — manual response"}; proposal only, nothing created.)`,
          missionTemplateId,
          category,
          overlappingKeywords: overlapping,
          source: "llm",
        };
      }
    }
  } catch {
    summary = null; // fall through to heuristic
  }
  if (!summary) {
    summary = heuristicSummary(deps, category, overlapping, missionTemplateId);
  }

  await deps.tx.competitorChange.update({
    where: { id: deps.changeId },
    data: {
      semanticSummary: summary.semanticSummary,
      whyItMatters: summary.whyItMatters,
      recommendedResponse: summary.recommendedResponse,
    },
  });
  return summary;
}
