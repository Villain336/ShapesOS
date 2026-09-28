// Marketr — Phase 13B eval 04: voice-fidelity blind eval.
//
// Contract under test (docs/phases/13b/DATA-MODEL.md):
//   BrandVoiceProfile → brand_voice_profiles: workspaceId unique,
//   dimensions { vocabulary, rhythm, formality, pov, humor, doExamples,
//   dontExamples }, derivedFrom { samples, editCount, lastDerivedAt },
//   confidence, pinnedByUser, pendingUpdates (learner proposals — applied
//   only on user accept).
//
// Acceptance: voice profile derived from 5+ samples → generated output
// rated "sounds like the samples" ≥ 4/5.
//
// Two modes:
//   - automated rubric (default): deterministic mock LLM applies the
//     profile dimensions; a rubric scores vocabulary/rhythm/pov/taboo
//     adherence 1–5. Target mean ≥ 4. (Caveat: the generator and the
//     scorer are both harness mocks — this validates the HARNESS, not a
//     real model. The binding acceptance is the human-rated mode +
//     real derivation.)
//   - human-rated: EVAL_HUMAN=1 (or --human) writes a blind review file
//     under lib/phase13b/evals/reviews/ for Tico to rate ≥4/5.
//
// Status: automated-mode harness validated; real derivation is PENDING
// until worker 2's deriveVoiceProfile lands.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED,
  createEvalWorkspace,
  deleteEvalWorkspace,
  probeFeature,
  type FeatureProbe,
} from "./harness";
import { prisma } from "../../prisma";
import { withWorkspaceScope } from "../../substrate/memory/rls";

const SUITE = "voice-fidelity";
let WS = "";
let derivation: FeatureProbe = { found: false, module: null, reason: "" };

const HUMAN_MODE =
  process.env.EVAL_HUMAN === "1" || process.argv.includes("--human");

// 6 samples: bold, short sentences, second-person, contractions, no emojis.
const SAMPLES = [
  "You don't need more tools. You need one plan you actually follow.",
  "Stop guessing. Pick the keyword, ship the page, measure the rank.",
  "Your funnel leaks at the headline. Fix that first. Everything else is noise.",
  "We tried the 40-page report. Nobody read it. One page wins.",
  "You'll waste a month on branding nobody remembers. Ship the offer.",
  "Rankings moved Tuesday. Here's exactly what changed and what to do.",
];

interface Dimensions {
  vocabulary: string[];
  rhythm: string;
  formality: string;
  pov: string;
  humor: string;
  doExamples: string[];
  dontExamples: string[];
}

/** Mock profile — what worker 2's deriveVoiceProfile should produce from SAMPLES. */
const MOCK_PROFILE: Dimensions = {
  vocabulary: ["ship", "stop", "fix", "measure", "noise"],
  rhythm: "short punchy sentences, rarely over 12 words",
  formality: "casual direct, contractions allowed",
  pov: "second person (you/your)",
  humor: "dry, minimal",
  doExamples: SAMPLES.slice(0, 2),
  dontExamples: ["We are pleased to announce our best-in-class solution.", "Great question! 🎉"],
};

/**
 * Mock LLM applying the profile: deterministic transform honoring the
 * dimensions. Stand-in for a real model until worker 2 lands.
 */
function mockApplyVoice(draft: string, d: Dimensions): string {
  let out = draft;
  if (d.pov.includes("second person")) {
    out = out
      .replace(/\bWe recommend that you\b/gi, "You")
      .replace(/\bOne should\b/g, "You should")
      .replace(/\bOur analysis indicates that rankings changed\.?/gi, "Your rankings changed.")
      .replace(/\bWe are pleased to present the recommended actions for your consideration\.?/gi, "Here's what you should do.");
  }
  if (d.formality.includes("casual")) {
    out = out
      .replace(/\bshould not\b/gi, "shouldn't")
      .replace(/\bdo not\b/gi, "don't")
      .replace(/\bcannot\b/gi, "can't");
  }
  // Vocabulary: map generic verbs to the profile's vocabulary.
  for (const v of d.vocabulary) {
    if (v === "fix") out = out.replace(/\bimprove the funnel\b/gi, "fix the funnel");
  }
  // Taboos: strip sycophantic openers rather than merely detecting them.
  out = out.replace(/^Great question!?\s*/i, "");
  // Rhythm: split long sentences at conjunctions to keep them short.
  const splitLong = (s: string) =>
    s.split(" ").length > 14
      ? s
          .replace(/, (and|but) /g, (_, c: string) => `. ${c[0].toUpperCase()}${c.slice(1)} `)
          .split(/(?<=[.!?])\s+/)
      : [s];
  out = out.split(/(?<=[.!?])\s+/).flatMap(splitLong).join(" ").replace(/\s+/g, " ").trim();
  return out;
}

interface RubricScores {
  vocabulary: number;
  rhythm: number;
  pov: number;
  taboos: number;
  mean: number;
}

/** Automated rubric 1–5 per axis. */
function scoreVoice(output: string, d: Dimensions, samples: string[]): RubricScores {
  const lemma = (w: string) => w.replace(/(ing|ed|es|s)$/, "");
  const words = output.toLowerCase().split(/\s+/).map(lemma);
  const vocabHits = d.vocabulary.filter((v) => words.includes(lemma(v))).length;
  const vocabulary = vocabHits >= 2 ? 5 : vocabHits === 1 ? 4 : 2;
  const sentences = output.split(/(?<=[.!?])\s+/).filter(Boolean);
  const avgLen = words.length / Math.max(sentences.length, 1);
  const rhythm = avgLen <= 14 ? 5 : avgLen <= 18 ? 4 : 2;
  const youCount = (output.match(/\b(you|your)\b/gi) ?? []).length;
  const pov = youCount >= 2 ? 5 : youCount >= 1 ? 3 : 1;
  const taboos = /🎉|😀|great question|best-in-class|pleased to announce/i.test(output) ? 1 : 5;
  const mean = (vocabulary + rhythm + pov + taboos) / 4;
  void samples;
  return { vocabulary, rhythm, pov, taboos, mean };
}

const DRAFTS = [
  "We recommend that you should not delay fixing the headline of the landing page, and you cannot improve the funnel without fixing the data first.",
  "Our analysis indicates that rankings changed. We are pleased to present the recommended actions for your consideration.",
];

before(async () => {
  derivation = await probeFeature("worker 4", ["../../intelligence/company/voice"], EXPECTED.voiceDerivation);
  WS = await createEvalWorkspace(SUITE, "Eval 13B voice fidelity");
  // Persist the mock profile via the real schema contract.
  await withWorkspaceScope(WS, (tx) =>
    tx.brandVoiceProfile.create({
      data: {
        workspaceId: WS,
        dimensions: MOCK_PROFILE as unknown as object,
        derivedFrom: { samples: SAMPLES, editCount: 0, lastDerivedAt: new Date().toISOString() },
        confidence: 0.72,
        pinnedByUser: false,
      },
    }),
  );
});

after(async () => {
  await deleteEvalWorkspace(WS);
  await prisma.$disconnect();
});

describe("voice-fidelity: profile contract (runs — real schema)", () => {
  it("profile persists with dimensions + provenance per the contract", async () => {
    const p = await withWorkspaceScope(WS, (tx) =>
      tx.brandVoiceProfile.findUnique({ where: { workspaceId: WS } }),
    );
    assert.ok(p, "profile row exists");
    const dims = p!.dimensions as unknown as Dimensions;
    for (const k of ["vocabulary", "rhythm", "formality", "pov", "humor", "doExamples", "dontExamples"]) {
      assert.ok((dims as unknown as Record<string, unknown>)[k] !== undefined, `dimensions.${k} present`);
    }
    const df = p!.derivedFrom as unknown as { samples: string[]; editCount: number; lastDerivedAt: string };
    assert.equal(df.samples.length, 6, "provenance: 6 samples recorded");
    assert.equal(df.editCount, 0);
  });

  it("learner voice proposals go to pendingUpdates, never straight to dimensions", async () => {
    const proposed = { proposedAt: new Date().toISOString(), dimensions: { formality: "more formal" }, rationale: "user edited toward formality twice" };
    await withWorkspaceScope(WS, (tx) =>
      tx.brandVoiceProfile.update({
        where: { workspaceId: WS },
        data: { pendingUpdates: proposed as unknown as object },
      }),
    );
    const p = await withWorkspaceScope(WS, (tx) =>
      tx.brandVoiceProfile.findUnique({ where: { workspaceId: WS } }),
    );
    assert.deepEqual((p!.pendingUpdates as unknown as { rationale: string }).rationale, proposed.rationale);
    assert.equal((p!.dimensions as unknown as Dimensions).formality, MOCK_PROFILE.formality, "dimensions untouched until user accepts");
  });
});

describe("voice-fidelity: automated rubric (runs — mocked LLM)", () => {
  it("mock-applied voice scores ≥4/5 on the rubric (harness self-check)", async () => {
    const scores: RubricScores[] = [];
    for (const draft of DRAFTS) {
      const out = mockApplyVoice(draft, MOCK_PROFILE);
      const s = scoreVoice(out, MOCK_PROFILE, SAMPLES);
      scores.push(s);
    }
    const mean = scores.reduce((a, s) => a + s.mean, 0) / scores.length;
    // NOTE: generator and scorer are both harness mocks — a PASS here
    // validates the harness wiring, NOT model quality. Binding acceptance
    // is the human-rated mode below + real derivation.
    assert.ok(mean >= 4, `automated rubric mean ${mean.toFixed(2)} ≥ 4/5`);
  });
});

describe("voice-fidelity: human-rated mode", () => {
  it(
    HUMAN_MODE
      ? "writes a blind review file for Tico (EVAL_HUMAN=1)"
      : "writes a blind review file for Tico — PENDING: run with EVAL_HUMAN=1 to write the review file",
    { skip: !HUMAN_MODE },
    async () => {
      const dir = join(dirname(fileURLToPath(import.meta.url)), "reviews");
      await mkdir(dir, { recursive: true });
      const outs = DRAFTS.map((d) => mockApplyVoice(d, MOCK_PROFILE));
      const stamp = new Date().toISOString().slice(0, 10);
      const file = join(dir, `voice-fidelity-blind-${stamp}.md`);
      const lines = [
        "# Voice-fidelity blind review (Phase 13B eval 04)",
        "",
        `Date: ${new Date().toISOString()} · Workspace: ${WS}`,
        "",
        "## Brand samples (the voice to match)",
        ...SAMPLES.map((s, i) => `${i + 1}. ${s}`),
        "",
        "## Generated outputs (rate each 1–5: \"sounds like us\")",
        ...outs.map((o, i) => `### Output ${i + 1}\n\n> ${o}\n\nRating (1–5): ___`),
        "",
        "## Rubric",
        "- 5: unmistakably the brand voice; 4: close, minor drift; 3: generic but acceptable;",
        "  2: off-voice; 1: wrong brand entirely.",
        "",
        "**Acceptance: mean ≥ 4/5.** Record the verdict here: PASS / FAIL, mean = ___.",
      ];
      await writeFile(file, lines.join("\n"));
      assert.ok(file.endsWith(".md"));
    },
  );
});

describe("voice-fidelity: real derivation (real deriveAndStoreVoiceProfile)", () => {
  it("deriveVoiceProfile from 5+ samples stores a dimensioned profile", async (t) => {
      if (!derivation.found) { t.skip("deriveAndStoreVoiceProfile not landed — battery ready for reuse"); return; }
    const mod = derivation.module as typeof import("../../intelligence/company/voice");
    const wsD = await createEvalWorkspace(SUITE, "Eval 13B voice derivation");
    try {
      const r = await mod.deriveAndStoreVoiceProfile(wsD, SAMPLES);
      assert.equal(r.applied, true, "profile applied on first derivation");
      for (const k of ["vocabulary", "rhythm", "formality", "pov", "humor", "doExamples", "dontExamples"]) {
        assert.ok((r.dimensions as unknown as Record<string, unknown>)[k] !== undefined, `dimensions.${k} present`);
      }
      assert.ok(r.derivedFrom.samples.length >= 6, `provenance: ${r.derivedFrom.samples.length} samples recorded`);
      assert.ok(r.confidence >= 0 && r.confidence <= 1, "confidence in [0,1]");
      // Pinned = read-only: derivation must refuse to overwrite.
      await mod.setVoicePinned(wsD, true);
      const r2 = await mod.deriveAndStoreVoiceProfile(wsD, SAMPLES);
      assert.equal(r2.applied, false, "pinned profile untouched by re-derivation");
      const stored = await withWorkspaceScope(wsD, (tx) =>
        tx.brandVoiceProfile.findUnique({ where: { workspaceId: wsD } }),
      );
      assert.ok(stored?.pinnedByUser, "pin persisted");
      // NOTE: binding "sounds like us ≥4/5" acceptance is the human blind
      // review (EVAL_HUMAN=1) — this automated block validates the real
      // derivation contract, not model quality.
    } finally {
      await deleteEvalWorkspace(wsD);
    }
  });
});
