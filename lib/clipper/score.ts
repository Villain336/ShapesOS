// Marketr — Phase 13C clipper: hook & virality scoring.
//
// LLM (background workload) scores candidate segments 0–100 with reasons.
// A `scorer` injection point lets callers (notably the eval tests in W5)
// substitute a deterministic scorer instead of the LLM. Scores are clamped
// and reasons normalized; candidates without reasons are dropped.

import { getLlmProviderFor, WORKLOAD_MAX_TOKENS } from "@/lib/llm/router";
import type { ClipCandidate, WordTimedTranscript } from "./types";
import { ServiceUnavailableError } from "@/lib/api/errors";

export interface ScoreOptions {
  /** How many candidate segments to ask for. */
  count: number;
}

/** Raw segment as returned by a scorer before normalization. */
export interface RawSegment {
  startSec: number;
  endSec: number;
  viralityScore: number;
  scoreReasons: unknown;
  hookText?: unknown;
}

/**
 * Deterministic scoring hook. Receives the prompt context (transcript +
 * target count) and returns raw segments. When provided, it is used
 * INSTEAD of the LLM — this is what the eval tests use.
 */
export type Scorer = (context: {
  transcriptText: string;
  count: number;
}) => Promise<RawSegment[]>;

/**
 * Build the scoring prompt. Virality dimensions per the 13C spec:
 * hook strength in the first 3 seconds, emotional arc, quotability,
 * and topic virality for the niche.
 */
export function buildScoringPrompt(
  transcriptText: string,
  count: number,
): string {
  return `You are a short-form video strategist. From the transcript below, pick the ${count} BEST candidate segments for viral 9:16 short-form video (15-60 seconds each).

Score each segment 0-100 on VIRALITY. Weight: (1) HOOK STRENGTH in the first 3 seconds — does it stop the scroll; (2) EMOTIONAL ARC — tension, surprise, payoff within the clip; (3) QUOTABILITY — a line people will repeat or share; (4) TOPIC VIRALITY — how the topic performs in this niche right now.

Segments must be self-contained: a viewer who only sees this clip must understand it. Prefer clean sentence boundaries.

Return ONLY a JSON array (no markdown fences, no commentary). Each item:
{
  "startSec": <number, seconds into the source>,
  "endSec": <number, seconds into the source>,
  "viralityScore": <number 0-100>,
  "scoreReasons": [<2-4 short strings, e.g. "hook: provocative claim in first 2s", "emotional arc: problem->reveal">],
  "hookText": "<the opening line of the segment>"
}

Transcript:
${transcriptText}`;
}

/** Score segments: deterministic scorer if injected, else the background LLM. */
export async function scoreSegments(
  transcript: WordTimedTranscript,
  opts: ScoreOptions,
  scorer?: Scorer,
): Promise<ClipCandidate[]> {
  const count = Math.max(1, Math.floor(opts.count));
  const raw: RawSegment[] = scorer
    ? await scorer({ transcriptText: transcript.text, count })
    : await scoreWithLlm(transcript.text, count);
  const normalized = normalizeSegments(raw);
  normalized.sort((a, b) => b.viralityScore - a.viralityScore);
  return normalized.slice(0, count);
}

/** LLM path: background workload, JSON parse, hard failure on garbage. */
async function scoreWithLlm(text: string, count: number): Promise<RawSegment[]> {
  const provider = getLlmProviderFor("background");
  if (!provider.isLive) {
    throw new ServiceUnavailableError(
      "Virality scoring needs a live LLM (background workload); the provider resolved to mock. Configure LLM keys to score clips.",
    );
  }
  const out = await provider.generate(buildScoringPrompt(text, count), {
    maxTokens: WORKLOAD_MAX_TOKENS.background,
  });
  return parseSegmentsJson(out);
}

/** Parse the LLM's JSON array; throws a clear error on malformed output. */
export function parseSegmentsJson(raw: string): RawSegment[] {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Scoring LLM returned non-JSON output; cannot score segments.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Scoring LLM returned a non-array JSON payload.");
  }
  return parsed as RawSegment[];
}

/**
 * Validate + normalize raw segments into ClipCandidate[]:
 *  - viralityScore clamped to 0–100 and rounded
 *  - start/end finite, ordered (start < end), both >= 0
 *  - scoreReasons coerced to a non-empty string[]; candidates with no
 *    usable reasons are DROPPED (a score without a reason is untrustworthy)
 *  - hookText coerced to string, defaults to ""
 */
export function normalizeSegments(raw: RawSegment[]): ClipCandidate[] {
  const out: ClipCandidate[] = [];
  for (const seg of raw) {
    if (typeof seg !== "object" || seg === null) continue;
    let startSec = Number(seg.startSec);
    let endSec = Number(seg.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    startSec = Math.max(0, startSec);
    endSec = Math.max(0, endSec);
    if (endSec <= startSec) continue;

    const viralityScore = Math.round(
      Math.min(100, Math.max(0, Number(seg.viralityScore) || 0)),
    );

    const scoreReasons = Array.isArray(seg.scoreReasons)
      ? seg.scoreReasons
          .map((r) => (typeof r === "string" ? r.trim() : String(r ?? "").trim()))
          .filter((r) => r.length > 0)
      : [];
    if (scoreReasons.length === 0) continue; // no reason → drop

    const hookText =
      typeof seg.hookText === "string" ? seg.hookText.trim() : "";
    out.push({ startSec, endSec, viralityScore, scoreReasons, hookText });
  }
  return out;
}
