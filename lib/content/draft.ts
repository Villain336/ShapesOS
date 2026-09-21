// Marketr — AI draft prompt builder (spec §5 flow 3, step 2).
// Turns a ContentBrief into the full prompt sent to the LlmProvider.
// The differentiator is the SERP-informed brief baked into the prompt,
// not the prose itself.

import type { ContentBrief } from "./brief";

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
