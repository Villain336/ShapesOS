// Marketr — Phase 13B Worker 4 tests: brand voice derivation.
// Run: npx tsx --test lib/intelligence/company/__tests__/voice.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeSamples, derivationConfidence } from "../voice";

const CASUAL_WE_SAMPLES = [
  "We built Marketr because we were tired of marketing tools that talk at you. We ship fast, we measure everything, and we tell you the truth even when it stings! You bring the business, we bring the growth engine that compounds your growth month after month!",
  "Our playbooks are battle-tested. We've run them across dozens of accounts, and we keep the ones that print money. No fluff, no vanity metrics — just the stuff that moves the needle for you and your team. Haha, we learned that lesson the expensive way so you don't have to!",
  "Hey, let's be real: most agencies sell you reports. We sell outcomes! Our dashboard shows you exactly what we did, what it cost, and what it earned. You'll love the transparency — growth you can actually see!",
];

const FORMAL_THIRD_SAMPLES = [
  "The organization provides comprehensive marketing intelligence solutions to enterprise clients operating across highly competitive verticals. Furthermore, the platform utilizes advanced analytical methodologies to deliver consistently measurable outcomes over extended engagement periods. Clients shall receive detailed quarterly performance reports pursuant to the agreed service schedule without exception.",
  "Our methodology is rigorous and has been refined through decades of combined professional experience across multiple industries. Therefore, all strategic recommendations are derived exclusively from empirical evidence and validated market research. Sincerely, the strategy team remains committed to excellence in all professional engagements.",
];

describe("analyzeSamples — seeded casual we/you samples", () => {
  const d = analyzeSamples(CASUAL_WE_SAMPLES);

  it("extracts distinctive vocabulary words", () => {
    assert.ok(d.vocabulary.length > 0, "vocabulary should not be empty");
    // distinctive content words from the samples should surface
    const vocab = d.vocabulary.join(" ");
    assert.ok(
      vocab.includes("marketr") || vocab.includes("marketing") || vocab.includes("growth"),
      `expected brand-domain words in vocabulary, got: ${vocab}`,
    );
  });

  it("detects a casual formality from contractions and exclamations", () => {
    assert.ok(
      d.formality.startsWith("casual"),
      `expected casual formality, got: ${d.formality}`,
    );
  });

  it("detects first-person-plural POV", () => {
    assert.ok(
      d.pov.startsWith("first-person plural"),
      `expected first-person plural POV, got: ${d.pov}`,
    );
  });

  it("detects a playful rhythm/humor profile", () => {
    assert.ok(
      d.humor.startsWith("playful") || d.humor.startsWith("dry wit"),
      `expected playful humor, got: ${d.humor}`,
    );
  });

  it("produces do and don't examples", () => {
    assert.ok(d.doExamples.length > 0, "doExamples should not be empty");
    assert.ok(d.dontExamples.length > 0, "dontExamples should not be empty");
    // A casual voice's don't-examples should warn against corporate stiffness
    assert.ok(
      d.dontExamples.some((e) => /corporate|stiff/i.test(e)),
      `expected a don't-example against stiff language, got: ${d.dontExamples.join(" | ")}`,
    );
  });
});

describe("analyzeSamples — seeded formal third-person samples", () => {
  const d = analyzeSamples(FORMAL_THIRD_SAMPLES);

  it("detects formal formality", () => {
    assert.ok(
      d.formality.startsWith("formal"),
      `expected formal formality, got: ${d.formality}`,
    );
  });

  it("detects long, flowing rhythm", () => {
    assert.ok(
      d.rhythm.includes("long and flowing") || d.rhythm.includes("balanced"),
      `expected long/balanced rhythm, got: ${d.rhythm}`,
    );
  });

  it("warns against slang in don't-examples", () => {
    assert.ok(
      d.dontExamples.some((e) => /slang/i.test(e)),
      `expected a don't-example against slang, got: ${d.dontExamples.join(" | ")}`,
    );
  });
});

describe("analyzeSamples — edge cases", () => {
  it("returns empty dimensions for no usable samples", () => {
    const d = analyzeSamples([]);
    assert.deepEqual(d.vocabulary, []);
    assert.equal(d.formality, "");
    assert.equal(d.pov, "");
  });

  it("ignores samples that are too short to analyze", () => {
    const d = analyzeSamples(["hi", "ok"]);
    assert.equal(d.formality, "");
  });

  it("confidence grows with sample volume", () => {
    const low = derivationConfidence(["short sample one", "short sample two"]);
    const high = derivationConfidence(
      Array.from({ length: 40 }, (_, i) => `sample ${i} with plenty of marketing words `.repeat(20)),
    );
    assert.ok(high > low, `expected higher confidence for more text (${high} vs ${low})`);
  });
});
