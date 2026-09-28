// Marketr — Phase 13C Worker 5: scoring/selection eval on a seeded 30-min fixture.
// Run: npx tsx --test lib/clipper/__tests__/scoring-eval.test.ts
// Injectable deps: deterministic scorer (no LLM), seeded-PRNG fixture —
// no network, no ffmpeg, no keys.
//
// NOTE on runner: the task brief said vitest, but this repo has no vitest
// and new npm deps are forbidden, so this suite follows the repo's actual
// convention (node:test via tsx), like lib/content/__tests__/repurpose.test.ts.
//
// Acceptance: a seeded ~30-minute transcript yields >=5 sensible clips —
// each 15-60s, cut on sentence boundaries, non-overlapping, highest-scoring
// clip opening inside the first-3s hook region.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scoreSegments } from "../score";
import type { Scorer } from "../score";
import { selectClips } from "../select";
import type { Word, WordTimedTranscript } from "../types";

/** Deterministic PRNG (mulberry32) — the fixture is stable across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILLER = (
  "growth marketing content audience brand strategy offer funnel email " +
  "social video podcast community product launch scale revenue retention " +
  "churn pricing copy hook story framework system playbook metric test " +
  "learn iterate ship build measure repeat"
).split(" ");

const HOOK_LEXICON = (
  "stop secret truth never always nobody everyone warning mistake " +
  "breakthrough proof exactly listen watch this why how"
).split(" ");

interface FixtureSentence {
  start: number;
  end: number;
  text: string;
}

/** Build a seeded ~30-minute WordTimedTranscript with sentence boundaries. */
function buildSeededTranscript(
  targetSec = 1800,
  seed = 1307,
): { transcript: WordTimedTranscript; sentences: FixtureSentence[] } {
  const rand = mulberry32(seed);
  const words: Word[] = [];
  const sentences: FixtureSentence[] = [];
  let t = 0;
  let sentenceIdx = 0;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  while (t < targetSec) {
    // High-energy "hook" regions: the cold open, one mid-video, one late.
    const inHookRegion =
      sentenceIdx < 6 ||
      (sentenceIdx >= 200 && sentenceIdx < 206) ||
      (sentenceIdx >= 380 && sentenceIdx < 386);
    const n = inHookRegion
      ? 5 + Math.floor(rand() * 3) // 5-7 short punchy words
      : 7 + Math.floor(rand() * 5); // 7-11 words
    const startT = t;
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const lex = inHookRegion && rand() < 0.35 ? HOOK_LEXICON : FILLER;
      let w = lex[Math.floor(rand() * lex.length)];
      if (i === 0) w = cap(w);
      if (i === n - 1) w += rand() < 0.75 ? "." : rand() < 0.5 ? "?" : "!";
      const dur = 0.26 + rand() * 0.14;
      const start = +t.toFixed(2);
      const end = +(t + dur).toFixed(2);
      words.push({ w, start, end });
      parts.push(w);
      t = end + 0.05;
    }
    sentences.push({
      start: +startT.toFixed(2),
      end: words[words.length - 1].end,
      text: parts.join(" "),
    });
    sentenceIdx++;
  }
  return {
    transcript: { words, text: words.map((w) => w.w).join(" ") },
    sentences,
  };
}

interface PlanSegment {
  start: number;
  end: number;
  score: number;
  reasons: string[];
  hookText: string;
}

/** Span whole sentences from firstIdx until the window reaches minSpan. */
function segmentFrom(
  sentences: FixtureSentence[],
  firstIdx: number,
  minSpan: number,
): { start: number; end: number } {
  const start = sentences[firstIdx].start;
  let j = firstIdx;
  while (j < sentences.length - 1 && sentences[j].end - start < minSpan) j++;
  return { start, end: sentences[j].end };
}

function firstSentenceAtOrAfter(
  sentences: FixtureSentence[],
  t: number,
): number {
  const i = sentences.findIndex((s) => s.start >= t);
  return i < 0 ? sentences.length - 1 : i;
}

/**
 * Deterministic stand-in for the LLM scorer: returns the planned raw
 * segments. Bounds sit a millisecond INSIDE the boundary words so the W2
 * sentence-snapper (wordIndexAt uses t < word.end) lands deterministically
 * on the exact sentence edges.
 */
function deterministicScorer(plan: PlanSegment[]): Scorer {
  return async () =>
    plan.map((p) => ({
      startSec: p.start + 0.001,
      endSec: p.end - 0.001,
      viralityScore: p.score,
      scoreReasons: p.reasons,
      hookText: p.hookText,
    }));
}

describe("13C scoring eval — seeded 30-min transcript", () => {
  it("yields >=5 sensible clips: 15-60s, sentence cuts, no overlaps, hook first", async () => {
    const { transcript, sentences } = buildSeededTranscript();
    const totalSec = transcript.words[transcript.words.length - 1].end;
    assert.ok(
      totalSec >= 1790,
      `fixture should be ~30 min, got ${totalSec.toFixed(1)}s`,
    );

    const specs = [
      {
        startIdx: 0,
        minSpan: 17,
        score: 96,
        reasons: [
          "hook: provocative claim in first 2s",
          "emotional arc: problem->reveal",
        ],
      },
      {
        startIdx: firstSentenceAtOrAfter(sentences, 300),
        minSpan: 25,
        score: 88,
        reasons: [
          "quotability: repeatable one-liner",
          "topic virality: niche hot topic",
        ],
      },
      {
        startIdx: firstSentenceAtOrAfter(sentences, 700),
        minSpan: 25,
        score: 82,
        reasons: ["emotional arc: tension->payoff", "hook: pattern interrupt"],
      },
      {
        startIdx: firstSentenceAtOrAfter(sentences, 1100),
        minSpan: 25,
        score: 77,
        reasons: [
          "quotability: contrarian take",
          "emotional arc: surprise reveal",
        ],
      },
      {
        startIdx: firstSentenceAtOrAfter(sentences, 1400),
        minSpan: 25,
        score: 71,
        reasons: ["hook: open loop", "topic virality: trending format"],
      },
      {
        startIdx: firstSentenceAtOrAfter(sentences, 1650),
        minSpan: 25,
        score: 64,
        reasons: [
          "emotional arc: stakes->resolution",
          "quotability: punchy close",
        ],
      },
    ];

    const plan: PlanSegment[] = specs.map((p) => {
      const { start, end } = segmentFrom(sentences, p.startIdx, p.minSpan);
      assert.ok(
        end - start >= 15 && end - start <= 55,
        `plan segment must sit inside 15-60s with margin, got ${(end - start).toFixed(1)}s`,
      );
      return {
        start,
        end,
        score: p.score,
        reasons: p.reasons,
        hookText: sentences[p.startIdx].text,
      };
    });

    // --- scoreSegments with the injected deterministic scorer -------------
    const candidates = await scoreSegments(
      transcript,
      { count: 6 },
      deterministicScorer(plan),
    );

    assert.ok(
      candidates.length >= 5,
      `expected >=5 candidates, got ${candidates.length}`,
    );
    for (const c of candidates) {
      assert.ok(
        Number.isInteger(c.viralityScore) &&
          c.viralityScore >= 0 &&
          c.viralityScore <= 100,
        `score out of 0-100: ${c.viralityScore}`,
      );
      assert.ok(
        c.scoreReasons.length >= 1,
        "every candidate must carry >=1 reason",
      );
      for (const r of c.scoreReasons) {
        assert.ok(
          typeof r === "string" && r.trim().length > 0,
          "reasons must be non-empty strings",
        );
      }
      assert.ok(c.endSec > c.startSec, "candidate window must be positive");
    }

    // --- selectClips: sentence snapping, 15-60s, dedupe -------------------
    const selected = selectClips(candidates, transcript, { count: 5 });
    assert.ok(
      selected.length >= 5,
      `expected >=5 selected clips, got ${selected.length}`,
    );

    for (const s of selected) {
      const dur = s.endSec - s.startSec;
      assert.ok(
        dur >= 15 && dur <= 60,
        `segment ${s.startSec}-${s.endSec} out of the 15-60s window`,
      );
    }

    // Cut points land on sentence boundaries (within 1 word — here, exactly).
    // Mirrors select.ts's sentence-end test; the test owns its copy so it
    // stays valid even if the implementation's regex moves.
    const SENT_END = /[.!?…]["'”’)]?$/;
    for (const s of selected) {
      const si = transcript.words.findIndex(
        (w) => Math.abs(w.start - s.startSec) < 0.06,
      );
      assert.ok(si >= 0, `start ${s.startSec} must land on a word start`);
      assert.ok(
        si === 0 || SENT_END.test(transcript.words[si - 1].w),
        `start ${s.startSec} must be a sentence start`,
      );
      const ei = transcript.words.findIndex(
        (w) => Math.abs(w.end - s.endSec) < 0.06,
      );
      assert.ok(ei >= 0, `end ${s.endSec} must land on a word end`);
      assert.ok(
        SENT_END.test(transcript.words[ei].w),
        `end ${s.endSec} must be a sentence end`,
      );
    }

    // No two selected segments overlap.
    for (let a = 0; a < selected.length; a++) {
      for (let b = a + 1; b < selected.length; b++) {
        const overlap =
          selected[a].startSec < selected[b].endSec &&
          selected[a].endSec > selected[b].startSec;
        assert.ok(!overlap, `segments ${a} and ${b} overlap`);
      }
    }

    // The top candidate is the opening hook: it starts in the first 3s.
    // selectClips keeps score-desc order, so selected[0] is the 96-pointer.
    assert.equal(
      selected[0].viralityScore,
      96,
      "first selected clip should be the highest-scoring candidate",
    );
    assert.ok(
      selected[0].startSec <= 3,
      `top candidate should start in the first-3s hook region, got ${selected[0].startSec}`,
    );
  });
});
