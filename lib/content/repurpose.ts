// Marketr — Phase 12: content repurposing ("Repurpose").
//
// Turns expert-corpus knowledge into derivative assets (content brief,
// video script, social thread, newsletter section) — the OpenNotebook-style
// "content repurposing" workflow, implemented as a native pipeline over our
// own RAG retrieval instead of a forked sidecar.
//
// Grounding contract:
//   1. retrieveExpertContext() supplies the source material (with attribution).
//   2. The LLM synthesizes ORIGINAL copy — never verbatim source text
//      (Tier 1S discipline: teach the substance, not the words).
//   3. Every output carries its source citations; mock (no-key) runs are
//      labeled mock:true, never presented as live expert output.

import { retrieveExpertContext } from "@/lib/intelligence/corpus/retrieve";
import type { ExpertHit } from "@/lib/intelligence/corpus/types";
import { getLlmProviderFor, llmStatus } from "@/lib/llm";

export type RepurposeFormatId = "brief" | "video-script" | "social-thread" | "newsletter";

export interface RepurposeFormat {
  id: RepurposeFormatId;
  label: string;
  description: string;
}

export const REPURPOSE_FORMATS: RepurposeFormat[] = [
  {
    id: "brief",
    label: "Content brief",
    description: "Audience, angle, key points, outline, and CTA for a writer or the content engine.",
  },
  {
    id: "video-script",
    label: "Video script",
    description: "60-second short-form script: hook, beats, on-screen text cues, CTA.",
  },
  {
    id: "social-thread",
    label: "Social thread",
    description: "Numbered X/LinkedIn thread distilled from the topic.",
  },
  {
    id: "newsletter",
    label: "Newsletter section",
    description: "Subject-line options plus a newsletter-ready section.",
  },
];

export interface RepurposeSource {
  title: string;
  author: string;
  license: string;
}

export interface RepurposeResult {
  format: RepurposeFormatId;
  topic: string;
  asset: string;
  sources: RepurposeSource[];
  /** True when the LLM layer was the mock provider (no key configured). */
  mock: boolean;
}

export interface RepurposeDeps {
  retrieve: (query: string, opts?: { topK?: number }) => Promise<ExpertHit[]>;
  generate: (prompt: string, opts?: { maxTokens?: number }) => Promise<string>;
  live: boolean;
}

function defaultDeps(): RepurposeDeps {
  const provider = getLlmProviderFor("bulk");
  return {
    retrieve: (q, opts) => retrieveExpertContext(q, opts),
    generate: (prompt, opts) => provider.generate(prompt, opts),
    live: llmStatus().isLive,
  };
}

const FORMAT_INSTRUCTIONS: Record<RepurposeFormatId, string> = {
  brief: `Write a CONTENT BRIEF with these sections:
## Audience
## Angle
## Key points (5-7 bullets)
## Suggested outline (H2s)
## Call to action`,
  "video-script": `Write a 60-SECOND SHORT-FORM VIDEO SCRIPT with these sections:
## Hook (first 3 seconds)
## Beats (timestamped, 0:00-0:60)
## On-screen text cues
## Call to action`,
  "social-thread": `Write a SOCIAL THREAD as numbered posts (1/, 2/, 3/ … — 7 posts max),
each post under 280 characters, first post is the hook, last post is the CTA.`,
  newsletter: `Write a NEWSLETTER SECTION with:
## Subject line options (3)
## Body (250-350 words, scannable with subheads)`,
};

function buildPrompt(topic: string, format: RepurposeFormatId, hits: ExpertHit[]): string {
  const context = hits
    .map(
      (h, i) =>
        `[Source ${i + 1}] "${h.sourceTitle}" by ${h.author} (${h.license}):\n${h.text.slice(0, 1500)}`,
    )
    .join("\n\n");
  return `You are Marketr's content repurposing engine. Topic: "${topic}".

Use ONLY the source material below as your factual basis. Synthesize it into ORIGINAL
copy — teach the substance in fresh words, NEVER reproduce source sentences verbatim.
End with a "Sources" list naming the sources you drew on (by title).

${FORMAT_INSTRUCTIONS[format]}

SOURCE MATERIAL:
${context || "(no corpus hits — say so honestly and write from general marketing best practice, labeled as such)"}`;
}

/**
 * repurposeContent({ topic, format }, deps?) — the repurposing pipeline.
 * deps is injectable so tests never need the local embedder or a live LLM.
 */
export async function repurposeContent(
  input: { topic: string; format: RepurposeFormatId; topK?: number },
  deps: RepurposeDeps = defaultDeps(),
): Promise<RepurposeResult> {
  const topic = (input.topic ?? "").trim();
  if (!topic) throw new Error("topic is required");
  if (!REPURPOSE_FORMATS.some((f) => f.id === input.format)) {
    throw new Error(`unknown format: ${input.format}`);
  }

  const hits = await deps.retrieve(topic, { topK: Math.min(Math.max(input.topK ?? 8, 1), 20) });
  const asset = await deps.generate(buildPrompt(topic, input.format, hits), { maxTokens: 2048 });

  return {
    format: input.format,
    topic,
    asset,
    sources: hits.map((h) => ({ title: h.sourceTitle, author: h.author, license: h.license })),
    mock: !deps.live,
  };
}
