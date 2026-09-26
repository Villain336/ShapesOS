// Marketr — Phase 10 M8 tests: taste guardrails.
// Run: npx tsx --test lib/intelligence/community/__tests__/taste.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { tasteCheck } from "../taste";

// A reply a real practitioner would write: short, specific, no hype.
const GOOD_DRAFT =
  "We ran into this last quarter. The fix that worked for us was moving " +
  "the keyword mapping into the brief template itself, so writers see the " +
  "target query before they draft. Cut our rewrite rate roughly in half. " +
  "Happy to share the template structure if useful.";

// Over-polished AI reply: emoji, sycophantic opener, marketing-speak,
// hype punctuation, brand pitch. Must FAIL on multiple axes.
const OVER_POLISHED_DRAFT =
  "🚀 Great question! As someone who works in this space, I can tell you " +
  "that leveraging our cutting-edge platform is a total game-changer!! " +
  "It will supercharge your workflow and unlock next-level growth. " +
  "Check out our free trial — we at Acme deliver world-class results. " +
  "Don't miss out, click here now!!!";

describe("tasteCheck", () => {
  it("PASSES a short, specific, human-sounding draft", () => {
    const r = tasteCheck(GOOD_DRAFT);
    assert.equal(r.ok, true, `expected pass, got failures: ${r.failures.join("; ")}`);
    assert.deepEqual(r.failures, []);
  });

  it("FAILS an over-polished AI draft on multiple axes", () => {
    const r = tasteCheck(OVER_POLISHED_DRAFT);
    assert.equal(r.ok, false);
    const joined = r.failures.join(" | ");
    assert.match(joined, /emoji/i, "should flag emoji");
    assert.match(joined, /sycophantic/i, "should flag the opener");
    assert.match(joined, /marketing-speak/i, "should flag marketing-speak");
    assert.match(joined, /exclamation|hype/i, "should flag hype punctuation");
    assert.match(joined, /astroturf|brand pitch/i, "should flag the brand pitch");
    assert.ok(r.failures.length >= 4, `expected >=4 failures, got ${r.failures.length}`);
  });

  it("FAILS drafts over the length cap", () => {
    const long = "This is a real sentence with concrete detail. ".repeat(40);
    const r = tasteCheck(long, { maxChars: 900 });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /too long/i.test(f)));
  });

  it("FAILS drive-by drafts under the substance floor", () => {
    const r = tasteCheck("This. Exactly this. Agreed.");
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /too short/i.test(f)));
  });

  it("FAILS carpet-bombed links", () => {
    const draft =
      "Three resources that helped us: https://a.example/1 and https://b.example/2 " +
      "and https://c.example/3 — all worth a read for this exact problem.";
    const r = tasteCheck(draft);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /links/i.test(f)));
  });

  it("FAILS ALL-CAPS shouting but allows legit acronyms", () => {
    const shouty =
      "THIS is the BEST approach and you MUST try it because the SEO results were AMAZING for our API.";
    const r = tasteCheck(shouty);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /ALL-CAPS/i.test(f)));

    const calm =
      "We tested this on our API docs. The SEO lift came from the FAQ schema, " +
      "not the copy changes — worth checking your Search Console coverage first.";
    assert.equal(tasteCheck(calm).ok, true);
  });

  it("FAILS 'delve' and other AI-tell vocabulary", () => {
    const draft =
      "Let me delve into this topic for you. The key insight is that consistency " +
      "beats intensity when you are building a content engine from scratch.";
    const r = tasteCheck(draft);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /delve/.test(f)));
  });

  it("FAILS empty drafts", () => {
    assert.equal(tasteCheck("").ok, false);
    assert.equal(tasteCheck("   ").ok, false);
  });

  it("honors per-source length caps", () => {
    const draft = "x".repeat(500);
    assert.equal(tasteCheck(draft, { maxChars: 900 }).ok, true);
    assert.equal(tasteCheck(draft, { maxChars: 400 }).ok, false);
  });
});
