// Marketr — AI draft prompt builder (spec §5 flow 3, step 2).
// Turns a ContentBrief into the full prompt sent to the LlmProvider.
// The differentiator is the SERP-informed brief baked into the prompt,
// not the prose itself.
//
// Phase 10 M9: the Expert Constitution Pack v1 content/brief constitution
// is the system-prompt layer — prepended here so it sits in front of the
// SERP brief grounding (the brief informs the expert; it never overrides
// the hard rules).

import type { ContentBrief } from "./brief";
import { constitutionSystemPrompt } from "@/lib/expert/constitution";

export function buildDraftPrompt(brief: ContentBrief): string {
  const outline = [
    `# ${brief.h1}`,
    ...brief.h2s.map((h) => `## ${h}`),
  ].join("\n");

  const paa = brief.paa.length
    ? brief.paa.map((q) => `- ${q}`).join("\n")
    : "(none)";

  const entities = brief.entities.length ? brief.entities.join(", ") : "(none)";

  return [
    // Constitution first: the content agent's system-prompt layer, in front
    // of the SERP-brief grounding below.
    constitutionSystemPrompt("content-brief"),
    ``,
    `You are an expert SEO content writer. Write a complete, original article targeting the keyword: "${brief.keyword}".`,
    ``,
    `Search intent: ${brief.intent}`,
    `Target length: approximately ${brief.targetWordCount} words.`,
    ``,
    `Follow this outline (use the H1 and H2s; you may add H3s where helpful):`,
    outline,
    ``,
    `Answer these reader questions naturally within the article:`,
    paa,
    ``,
    `Naturally include these related terms and topics: ${entities}.`,
    ``,
    `Rules:`,
    `- Start with the H1 as the very first line.`,
    `- Include the exact keyword in the first 100 words.`,
    `- Write in a helpful, specific tone. No fluff, no placeholder text, no meta-commentary about the article itself.`,
    `- Output markdown only.`,
  ].join("\n");
}
