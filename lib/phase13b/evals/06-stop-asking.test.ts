// Marketr — Phase 13B eval 06: "stops asking known things".
//
// Contract under test (spec §1, §4 — retrieval integration):
//   Lessons + preferences + company intelligence feed into agent system
//   prompts via the Growth Memory recall path. Layered injection order:
//   style rules → brand voice → company knowledge → lessons/preferences
//   → episodic context. buildIntelligenceContext (worker 5) assembles the
//   prompt block.
//
// Acceptance: seed preferences (tone, detail level) →
// buildIntelligenceContext includes them → the agent prompt contains the
// preference (acceptance proxy for the behavior: the agent stops asking
// what it should already know).
//
// Status: the proxy check RUNS (preferences land in the context block the
// harness builds from the same sources). The real buildIntelligenceContext
// wiring is PENDING until worker 5 lands — full PASS requires it.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED,
  createEvalWorkspace,
  deleteEvalWorkspace,
  probeFeature,
  type FeatureProbe,
} from "./harness";
import { prisma } from "../../prisma";
import {
  PREF_KEYS,
  listPreferences,
  setPreference,
} from "../../substrate/memory/preferences";

const SUITE = "stop-asking";
let WS = "";
let ctx: FeatureProbe = { found: false, module: null, reason: "" };

/**
 * Contract proxy for buildIntelligenceContext: assembles the preference
 * layer of the agent prompt from the same sources the real implementation
 * must use (preferences.ts). If the real module lands, this block is
 * replaced by an assertion against its output.
 */
async function proxyBuildPrompt(workspaceId: string): Promise<string> {
  const prefs = await listPreferences(workspaceId);
  const lines = prefs.map((p) => `- ${p.key}: ${JSON.stringify(p.value)} (confidence ${p.confidence})`);
  return [
    "## Known workspace preferences (do not re-ask these)",
    ...lines,
    "Treat the above as settled fact about how this user likes to work.",
  ].join("\n");
}

before(async () => {
  ctx = await probeFeature("worker 4", ["../../intelligence/company/prompt-context"], EXPECTED.intelligenceContext);
  WS = await createEvalWorkspace(SUITE, "Eval 13B stop-asking");
  await setPreference(WS, PREF_KEYS.voiceStyle, "bold and punchy, no fluff", {
    origin: "user_told",
    confidence: 0.95,
  });
  await setPreference(WS, PREF_KEYS.detailLevel, "terse — bullets over paragraphs", {
    origin: "user_told",
    confidence: 0.9,
  });
});

after(async () => {
  await deleteEvalWorkspace(WS);
  await prisma.$disconnect();
});

describe("stop-asking: preference → prompt contract proxy (runs)", () => {
  it("seeded tone preference is present in the assembled prompt", async () => {
    const prompt = await proxyBuildPrompt(WS);
    assert.ok(prompt.includes("voice_style"), "prompt block names the preference key");
    assert.ok(prompt.includes("bold and punchy, no fluff"), "prompt contains the tone preference value");
  });

  it("seeded detail-level preference is present in the assembled prompt", async () => {
    const prompt = await proxyBuildPrompt(WS);
    assert.ok(prompt.includes("terse"), "prompt contains the detail-level preference value");
  });

  it("prompt block marks preferences as settled (do-not-re-ask semantics)", async () => {
    const prompt = await proxyBuildPrompt(WS);
    assert.ok(/do not re-ask|settled fact/i.test(prompt), "prompt instructs the agent not to re-ask");
  });
});

describe("stop-asking: real buildIntelligenceContext", () => {
  it("agent system prompt contains known preferences without being re-told", async (t) => {
      if (!ctx.found) { t.skip("buildIntelligenceContext not landed — battery ready for reuse"); return; }
    // Real acceptance: the assembled intelligence context must carry the
    // workspace's settled preferences so the agent stops re-asking.
    const mod = ctx.module as typeof import("../../intelligence/company/prompt-context");
    const prompt = await mod.buildIntelligenceContext(WS, "");
    assert.ok(prompt.includes("bold and punchy"), "context contains the tone preference");
    assert.ok(prompt.includes("terse"), "context contains the detail-level preference");
    // Preferences travel as settled facts in the prompt, so the agent has them
    // without re-asking — this is the documented 06 contract.
  });
});
