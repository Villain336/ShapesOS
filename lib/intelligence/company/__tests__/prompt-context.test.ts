// Marketr — Phase 13B Worker 4 tests: prompt-context layering.
// Run: npx tsx --test lib/intelligence/company/__tests__/prompt-context.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildIntelligenceContext,
  LAYER_HEADERS,
  type IntelligenceDeps,
} from "../prompt-context";
import type { RecallHit } from "@/lib/substrate/memory/types";
import type { CompanyKnowledge, StyleRule } from "@prisma/client";

function styleRule(over: Partial<StyleRule>): StyleRule {
  return {
    id: `sr-${Math.random().toString(36).slice(2)}`,
    workspaceId: "ws-test",
    kind: "ban",
    pattern: "x",
    replacement: null,
    severity: "flag",
    pinned: false,
    active: true,
    source: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as StyleRule;
}

function knowledge(over: Partial<CompanyKnowledge>): CompanyKnowledge {
  return {
    id: `ck-${Math.random().toString(36).slice(2)}`,
    workspaceId: "ws-test",
    kind: "product",
    title: "Entry",
    body: {},
    confidence: 1,
    pinned: false,
    sourceEpisodeId: null,
    validFrom: null,
    validTo: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as CompanyKnowledge;
}

function hit(over: Partial<RecallHit>): RecallHit {
  return {
    store: "learning",
    refId: "ref-1",
    title: "Hit",
    body: "body text",
    subtitle: null,
    observedAt: new Date(),
    validFrom: null,
    validTo: null,
    episodeId: null,
    fusedScore: 0.9,
    rerankScore: null,
    score: 0.9,
    exactMatch: false,
    embedding: null,
    ...over,
  };
}

const FULL_DEPS: IntelligenceDeps = {
  loadStyleRules: async () => [
    styleRule({ id: "sr1", kind: "ban", pattern: "cheap", severity: "block", replacement: "affordable" }),
    styleRule({ id: "sr2", kind: "require", pattern: "results may vary", severity: "flag" }),
  ],
  loadVoice: async () => ({
    dimensions: {
      vocabulary: ["growth", "engine"],
      rhythm: "short and punchy — sentences average 8 words",
      formality: "casual — conversational",
      pov: "first-person plural (we/our)",
      humor: "playful",
      doExamples: ["We ship fast and measure everything."],
      dontExamples: ["Don't be stiff."],
    },
  }),
  loadKnowledge: async () => [
    knowledge({
      id: "ck1",
      kind: "product",
      title: "Marketr",
      body: { summary: "Marketing OS", features: ["keyword research", "AI content"] },
    }),
    knowledge({
      id: "ck2",
      kind: "competitor",
      title: "Cheaprival",
      // Contains the banned word → must trigger the conflict note.
      body: { strengths: ["cheap pricing"], weaknesses: ["no support"] },
    }),
  ],
  recall: async () => [
    hit({ store: "learning", title: "Lead with the number", body: "cut fluffy intros" }),
    hit({ store: "fact", title: "Channel preference", body: "prefers email" }),
    hit({ store: "episode", title: "Last week's keyword review", body: "decided to target X" }),
  ],
  loadPreferences: async () => [
    { key: "voice_style", value: "bold" },
    { key: "risk_tolerance", value: "low" },
  ],
};

const EMPTY_DEPS: IntelligenceDeps = {
  loadStyleRules: async () => [],
  loadVoice: async () => ({ dimensions: null }),
  loadKnowledge: async () => [],
  recall: async () => [],
  loadPreferences: async () => [],
};

describe("buildIntelligenceContext — layering order", () => {
  it("emits layers in the spec-§4 order: rules → voice → knowledge → lessons → episodes", async () => {
    const ctx = await buildIntelligenceContext("ws-test", "grow revenue", FULL_DEPS);
    const idx = (h: string) => ctx.indexOf(h);
    const order = [
      LAYER_HEADERS.rules,
      LAYER_HEADERS.voice,
      LAYER_HEADERS.knowledge,
      LAYER_HEADERS.lessons,
      LAYER_HEADERS.episodes,
    ];
    for (const h of order) {
      assert.ok(idx(h) >= 0, `missing layer header: ${h}`);
    }
    for (let i = 0; i < order.length - 1; i++) {
      assert.ok(
        idx(order[i]!) < idx(order[i + 1]!),
        `layer order violated: "${order[i]}" must precede "${order[i + 1]}"`,
      );
    }
  });

  it("includes style rules verbatim as hard constraints", async () => {
    const ctx = await buildIntelligenceContext("ws-test", "q", FULL_DEPS);
    assert.ok(ctx.includes('"cheap"'), "ban pattern must appear verbatim");
    assert.ok(
      ctx.includes('say "affordable" instead'),
      "ban replacement must appear verbatim",
    );
    assert.ok(ctx.includes('"results may vary"'), "require pattern must appear verbatim");
  });

  it("adds a HARD CONSTRAINT WINS note when a ban rule conflicts with knowledge text", async () => {
    const ctx = await buildIntelligenceContext("ws-test", "q", FULL_DEPS);
    assert.ok(
      ctx.includes("HARD CONSTRAINT WINS"),
      `expected conflict note, got:\n${ctx}`,
    );
    assert.ok(
      ctx.includes('"cheap"'),
      "conflict note must name the conflicting rule",
    );
  });

  it("renders voice, knowledge, lessons, preferences, and episodes", async () => {
    const ctx = await buildIntelligenceContext("ws-test", "q", FULL_DEPS);
    assert.ok(ctx.includes("short and punchy"), "voice rhythm missing");
    assert.ok(ctx.includes("Marketing OS"), "knowledge summary missing");
    assert.ok(ctx.includes("### product"), "knowledge grouped by kind");
    assert.ok(ctx.includes("Lead with the number"), "learning missing");
    assert.ok(ctx.includes('Preference "voice_style": bold'), "preference missing");
    assert.ok(ctx.includes("Last week's keyword review"), "episode missing");
  });

  it("returns empty string when every layer is empty", async () => {
    const ctx = await buildIntelligenceContext("ws-test", "q", EMPTY_DEPS);
    assert.equal(ctx, "");
  });

  it("omits empty layers instead of printing empty headers", async () => {
    const deps: IntelligenceDeps = {
      ...EMPTY_DEPS,
      loadStyleRules: FULL_DEPS.loadStyleRules,
    };
    const ctx = await buildIntelligenceContext("ws-test", "q", deps);
    assert.ok(ctx.includes(LAYER_HEADERS.rules));
    assert.ok(!ctx.includes(LAYER_HEADERS.voice), "empty voice layer must be omitted");
    assert.ok(!ctx.includes(LAYER_HEADERS.knowledge), "empty knowledge layer must be omitted");
  });
});
