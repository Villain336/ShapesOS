// Marketr — Qwen3.8-27B self-host copy benchmark SKELETON (Phase D).
//
// Purpose: run Marketr's real brief/article prompts against any
// OpenAI-compatible endpoint (e.g. vLLM serving Qwen3.8-27B) and score the
// outputs HEURISTICALLY (structure, keyword coverage, length, mock-markers).
//
// THIS IS NOT A QUALITY PROOF. A passing score does not mean the model writes
// good marketing copy — only a human read of the saved outputs does. The
// script saves every output to ./benchmark-output/ for that review.
//
// Run: LLM_BASE_URL=http://localhost:8000/v1 LLM_API_KEY=dummy \
//      BENCH_MODEL=qwen3.8-27b npx tsx scripts/benchmark-qwen-copy.mts
// Offline: without LLM_BASE_URL it scores the mock provider (sanity check).

import { mkdirSync, writeFileSync } from "node:fs";

const BASE_URL = (process.env.LLM_BASE_URL ?? "").trim();
const API_KEY = (process.env.LLM_API_KEY ?? "dummy").trim();
const MODEL = (process.env.BENCH_MODEL ?? "qwen3.8-27b").trim();
const OUT_DIR = "benchmark-output";

interface BenchCase {
  name: string;
  prompt: string;
  keyword: string;
  minWords: number;
}

const CASES: BenchCase[] = [
  {
    name: "content-brief",
    keyword: "project management software",
    minWords: 150,
    prompt: [
      "Write a content brief for an article targeting the keyword:",
      '"project management software".',
      "Include: search intent, target audience, suggested H1, 5 H2 sections",
      "with 2-3 bullet talking points each, and 4 FAQ questions.",
    ].join("\n"),
  },
  {
    name: "article-draft",
    keyword: "project management software",
    minWords: 400,
    prompt: [
      "Write a full marketing article targeting the keyword:",
      '"project management software".',
      "Requirements: an H1, an intro paragraph, at least 4 H2 sections with",
      "substantive paragraphs (not filler), a practical how-to-choose section,",
      "and an FAQ with 3 questions. Natural, confident tone — no hype, no",
      'filler phrases like "in today\'s fast-paced world".',
    ].join("\n"),
  },
  {
    name: "content-refresh",
    keyword: "email marketing best practices",
    minWords: 250,
    prompt: [
      "Refresh this stale article draft for the keyword",
      '"email marketing best practices". Keep what still works, rewrite what."',
      "is dated, and add one new section on 2026 deliverability changes.",
      "Return the full refreshed article in markdown with H1/H2 structure.",
    ].join("\n"),
  },
];

interface Score {
  name: string;
  words: number;
  minWords: number;
  hasH1: boolean;
  h2Count: number;
  keywordMentions: number;
  hasMockMarker: boolean;
  hasFillerCliche: boolean;
  passed: boolean;
}

const FILLER = [
  "in today's fast-paced world",
  "in the ever-evolving landscape",
  "delve",
  "furthermore,",
  "it is worth noting that",
];

function scoreOutput(c: BenchCase, text: string): Score {
  const words = text.split(/\s+/).filter(Boolean).length;
  const keywordRe = new RegExp(
    c.keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "gi",
  );
  const s: Score = {
    name: c.name,
    words,
    minWords: c.minWords,
    hasH1: /^# /m.test(text),
    h2Count: (text.match(/^## /gm) ?? []).length,
    keywordMentions: (text.match(keywordRe) ?? []).length,
    hasMockMarker: /> \*\*Mock draft\*\*/.test(text),
    hasFillerCliche: FILLER.some((f) => text.toLowerCase().includes(f)),
    passed: false,
  };
  s.passed =
    s.words >= s.minWords &&
    s.hasH1 &&
    s.h2Count >= 3 &&
    s.keywordMentions >= 3 &&
    !s.hasMockMarker;
  return s;
}

async function generate(prompt: string): Promise<string> {
  if (!BASE_URL) {
    const { MockLlmProvider } = await import("../lib/llm/mock.js");
    return new MockLlmProvider().generate(prompt);
  }
  const res = await fetch(`${BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 4096,
    }),
  });
  if (!res.ok) throw new Error(`endpoint returned HTTP ${res.status}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("endpoint returned an empty response");
  }
  return text.trim();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`benchmark-qwen-copy: model="${MODEL}" endpoint=${BASE_URL || "(mock, offline)"}`);
  console.log("HEURISTIC SCORES ONLY — not a copy-quality proof. Read ./benchmark-output/.\n");

  let failures = 0;
  for (const c of CASES) {
    let text: string;
    try {
      text = await generate(c.prompt);
    } catch (err) {
      console.log(`  ${c.name}: ERROR ${err instanceof Error ? err.message : err}`);
      failures++;
      continue;
    }
    writeFileSync(`${OUT_DIR}/${c.name}.md`, text);
    const s = scoreOutput(c, text);
    if (!s.passed) failures++;
    console.log(
      `  ${s.passed ? "PASS" : "FAIL"} ${s.name}: ${s.words}w (min ${s.minWords}), ` +
        `h1=${s.hasH1} h2=${s.h2Count} kw=${s.keywordMentions} ` +
        `mock=${s.hasMockMarker} cliche=${s.hasFillerCliche}`,
    );
  }
  console.log(
    failures === 0
      ? "\nAll heuristic checks passed. REMINDER: have a human read the outputs before routing client copy here."
      : `\n${failures} case(s) failed heuristics. Do not route client copy to this endpoint.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("benchmark failed:", err instanceof Error ? err.message : err);
  process.exit(2);
});
