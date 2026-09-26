// Marketr — Phase 10 M3: citation-gap → action mapping.
//
// Turns "Perplexity cites competitor X's pricing page for 8/15 buyer prompts;
// your page lacks [structured facts]" into a handoff object for the Phase 2
// content engine's brief builder (lib/content/brief.ts, built via
// POST /api/content/brief, UI at /dashboard/projects/[id]/content). This module
// does NOT rebuild the brief generator — it wires the handoff (gap →
// suggested brief inputs → deep link carrying the gap context). The content
// tab reads the gapKeyword/gapEngines/gapCompetitors/gapFacts query params and
// renders the handoff as a banner: the operator saves the phrase as a keyword,
// then builds the brief from it in the normal flow.

import type { CitationGap } from "./citations";
import { normalizeCitationDomain } from "./citations";

export interface BriefSourceSuggestion {
  title: string;
  url: string;
  domain: string;
}

export interface CitationGapHandoff {
  kind: "citation-gap";
  promptIdx: number;
  /** The buyer prompt this gap was detected on. */
  prompt: string;
  /** Engines where competitors are cited and the owned domain is not. */
  engines: string[];
  competitorDomains: string[];
  competitorUrls: string[];
  ownedDomain: string;
  /** Ready-to-feed inputs for the Phase 2 brief builder. */
  suggestedBrief: {
    keyword: string;
    sources: BriefSourceSuggestion[];
    /** Structured facts the owned page likely lacks (inferred from URL shape). */
    structuredFactsMissing: string[];
    note: string;
  };
  /** Deep link into the brief builder UI with the gap prefilled. */
  briefBuilderUrl: string;
  createdAt: string;
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const slug = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const words = slug.replace(/[-_]+/g, " ").replace(/\.\w+$/, "").trim();
    return words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : u.hostname;
  } catch {
    return url;
  }
}

/** Infer likely-missing structured facts from competitor URL shapes. */
export function inferStructuredFactsMissing(urls: string[]): string[] {
  const facts = new Set<string>();
  for (const url of urls) {
    const path = (() => {
      try {
        return new URL(url).pathname.toLowerCase();
      } catch {
        return url.toLowerCase();
      }
    })();
    if (/pric|plan|cost/.test(path)) {
      facts.add("pricing facts (tiers, per-seat cost, billing cadence)");
      facts.add("comparison table vs named alternatives");
    }
    if (/doc|guide|how|tutorial/.test(path)) {
      facts.add("step-by-step how-to with named steps");
      facts.add("FAQ block answering the prompt's question verbatim");
    }
    if (/vs|compar|alternative/.test(path)) {
      facts.add("head-to-head comparison data");
    }
    if (/review/.test(path)) {
      facts.add("third-party review signals (ratings, review counts)");
    }
  }
  if (facts.size === 0) {
    facts.add("concise factual summary answering the prompt in ≤80 words");
    facts.add("named entity facts (product name, category, key attributes)");
  }
  return [...facts];
}

/**
 * Build the handoff object from a detected citation gap. Pure — the API route
 * or UI passes the gap + the panel's prompt text. opts.projectId selects the
 * destination content engine tab; without it the link lands on the project
 * picker (the operator picks the project whose content should close the gap).
 */
export function gapToBriefHandoff(
  gap: CitationGap,
  prompt: string,
  ownedDomain: string,
  opts: { projectId?: string } = {},
): CitationGapHandoff {
  const sources: BriefSourceSuggestion[] = gap.competitorUrls.map((url) => ({
    title: titleFromUrl(url),
    url,
    domain: normalizeCitationDomain(url) ?? url,
  }));
  const structuredFactsMissing = inferStructuredFactsMissing(gap.competitorUrls);
  const keyword = prompt.length > 90 ? `${prompt.slice(0, 90)}…` : prompt;
  const params = new URLSearchParams({
    gapKeyword: keyword,
    gapEngines: gap.engines.join(","),
    gapCompetitors: gap.competitorDomains.slice(0, 5).join(","),
    gapFacts: structuredFactsMissing.slice(0, 4).join(" | ").slice(0, 400),
  });
  const briefBuilderUrl = opts.projectId
    ? `/dashboard/projects/${opts.projectId}/content?${params.toString()}`
    : `/dashboard/projects?${params.toString()}`;
  return {
    kind: "citation-gap",
    promptIdx: gap.promptIdx,
    prompt,
    engines: gap.engines,
    competitorDomains: gap.competitorDomains,
    competitorUrls: gap.competitorUrls,
    ownedDomain,
    suggestedBrief: {
      keyword,
      sources,
      structuredFactsMissing,
      note: `Engines cite ${gap.competitorDomains.slice(0, 3).join(", ") || "competitors"} where ${ownedDomain} is absent. Save the keyword in the content engine, then build the brief — feed these sources so the owned page carries the structured facts engines quote.`,
    },
    briefBuilderUrl,
    createdAt: new Date().toISOString(),
  };
}
