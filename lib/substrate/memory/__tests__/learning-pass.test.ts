// Marketr — Phase 13B learning-pass ("sleep") tests.
// Run: npx tsx --test lib/substrate/memory/__tests__/learning-pass.test.ts
//
// DB-backed (preview Postgres, port 5433): each test uses a fresh workspace
// id and all are deleted at teardown. The LLM is INJECTED (deterministic
// mock JSON) — no network, no keys, no cost. Embeddings run on the local
// cached model via recordEpisode/recordLearning (same path as production).

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { prisma } from "../../../../lib/prisma";
import { withWorkspaceScope } from "../rls";
import { startConsolidationRun } from "../consolidate";
import { recordEpisode, recordLearning } from "../write";
import { setLearningPaused } from "../preferences";
import {
  executeLearningPass,
  parseLearningPassOutput,
  textSimilarity,
  normalizeLearningText,
} from "../learning-pass";

const created: string[] = [];
async function freshWorkspace(): Promise<string> {
  const id = `ws_learning_test_${randomUUID().slice(0, 8)}`;
  await prisma.workspace.create({
    data: { id, name: "learning-pass test", ownerUserId: "user_test_owner" },
  });
  created.push(id);
  return id;
}

after(async () => {
  for (const id of created) {
    await prisma.workspace.deleteMany({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

function mockLlmJson(payload: unknown) {
  const json = JSON.stringify(payload);
  return async (_prompt: string) => json;
}

const VOICE_PROPOSAL = {
  dimensions: {
    vocabulary: ["concrete", "direct"],
    rhythm: "short sentences",
    formality: "bold, plainspoken",
    pov: "second person",
    humor: "none",
    doExamples: ["Lead with the number."],
    dontExamples: ["Synergy-driven fluff."],
  },
  rationale: "Edits consistently strip hedging and add concrete numbers.",
};

const FULL_PAYLOAD = {
  lessons: [
    {
      hypothesis: "Always lead with the number; cut fluffy intros",
      confidence: 0.85,
      result: "worked",
      evidence: [],
    },
    { hypothesis: "End CTAs with a single clear action", confidence: 0.7 },
  ],
  voiceProposal: VOICE_PROPOSAL,
  knowledge: [
    {
      kind: "product",
      title: "Starter plan",
      body: { summary: "Entry tier for small teams", features: ["5 seats"] },
      confidence: 0.7,
    },
  ],
  styleRules: [
    {
      kind: "ban",
      pattern: "synergy",
      replacement: "working together",
      severity: "flag",
    },
  ],
};

async function seedEpisode(ws: string): Promise<string> {
  const { id } = await recordEpisode(ws, {
    episodeType: "agent_call",
    actor: "business-strategist",
    summary:
      "Drafted a landing page for the Starter plan; the user edited the intro to lead with the price and removed the word synergy. Decided the number-first structure converts better.",
    refs: { promptSummary: "write landing page", outcome: "edited" },
  });
  await withWorkspaceScope(ws, async (tx) => {
    await tx.agentFeedback.create({
      data: {
        workspaceId: ws,
        episodeId: id,
        agentId: "business-strategist",
        kind: "edit_diff",
        signal: {
          before: "Experience synergy-driven growth with our amazing platform.",
          after: "$29/mo. Five seats. Cancel anytime.",
          diffStats: { removed: 6, added: 5 },
        },
      },
    });
  });
  return id;
}

async function seedVoiceProfile(ws: string, pinned: boolean) {
  await withWorkspaceScope(ws, async (tx) => {
    await tx.brandVoiceProfile.create({
      data: {
        workspaceId: ws,
        dimensions: {
          vocabulary: [],
          rhythm: "varied",
          formality: "neutral",
          pov: "third person",
          humor: "none",
          doExamples: [],
          dontExamples: [],
        },
        derivedFrom: { samples: [], editCount: 0, lastDerivedAt: new Date().toISOString() },
        confidence: 0.6,
        pinnedByUser: pinned,
      },
    });
  });
}

describe("learning-pass: lesson extraction (mock LLM)", () => {
  it("extracts lessons from seeded episodes + edit-diff feedback", async () => {
    const ws = await freshWorkspace();
    await seedEpisode(ws);
    const report = await executeLearningPass(ws, {
      llm: mockLlmJson({ lessons: FULL_PAYLOAD.lessons, voiceProposal: null, knowledge: [], styleRules: [] }),
      modelLabel: "test",
    });
    assert.equal(report.status, "ran");
    assert.equal(report.learningsExtracted, 2);
    assert.equal(report.learningsSkippedDup, 0);
    assert.ok(report.llmUsage);
    assert.equal(report.llmUsage!.model, "test");
    assert.ok(report.llmUsage!.estInputTokens > 0);
    assert.ok(report.llmUsage!.estOutputTokens > 0);

    const rows = await withWorkspaceScope(ws, async (tx) =>
      tx.memoryLearning.findMany({
        where: { workspaceId: ws, invalidatedAt: null },
        select: { hypothesis: true, source: true, metricDelta: true, action: true },
      }),
    );
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.source, "consolidation");
    const confs = rows.map((r) => (r.metricDelta as { confidence: number }).confidence).sort();
    assert.deepEqual(confs, [0.7, 0.85]);
    assert.ok(rows[0].action.includes("learning pass"));
  });
});

describe("learning-pass: semantic dedupe", () => {
  it("skips a new lesson that duplicates an active learning", async () => {
    const ws = await freshWorkspace();
    await seedEpisode(ws);
    await recordLearning(ws, {
      hypothesis: "Always lead with the number; cut fluffy intros",
      action: "seeded directly for the learning-pass test",
      result: "worked",
      metricDelta: { confidence: 0.9 },
      contextRefs: { origin: "agent_inferred" },
      source: "consolidation",
    });
    const report = await executeLearningPass(ws, {
      llm: mockLlmJson({
        lessons: [
          { hypothesis: "Always lead with the number and cut the fluffy intros", confidence: 0.8 },
        ],
        voiceProposal: null,
        knowledge: [],
        styleRules: [],
      }),
      modelLabel: "test",
    });
    assert.equal(report.learningsExtracted, 0);
    assert.equal(report.learningsSkippedDup, 1);
    const rows = await withWorkspaceScope(ws, async (tx) =>
      tx.memoryLearning.findMany({
        where: { workspaceId: ws, invalidatedAt: null },
        select: { id: true },
      }),
    );
    assert.equal(rows.length, 1); // no duplicate inserted
  });

  it("retires later-written near-duplicates via invalidatedAt (never delete)", async () => {
    const ws = await freshWorkspace();
    await seedEpisode(ws);
    const first = await recordLearning(ws, {
      hypothesis: "End CTAs with a single clear action",
      action: "seeded directly for the learning-pass test",
      result: "worked",
      metricDelta: { confidence: 0.9 },
      contextRefs: { origin: "agent_inferred" },
      source: "consolidation",
    });
    const second = await recordLearning(ws, {
      hypothesis: "End CTAs with one single clear action",
      action: "seeded directly for the learning-pass test",
      result: "worked",
      metricDelta: { confidence: 0.85 },
      contextRefs: { origin: "agent_inferred" },
      source: "consolidation",
    });
    const report = await executeLearningPass(ws, {
      llm: mockLlmJson({ lessons: [], voiceProposal: null, knowledge: [], styleRules: [] }),
      modelLabel: "test",
    });
    assert.ok(report.learningsDecayed >= 1);
    const rows = await withWorkspaceScope(ws, async (tx) =>
      tx.memoryLearning.findMany({
        where: { workspaceId: ws, id: { in: [first.id, second.id] } },
        select: { id: true, invalidatedAt: true },
      }),
    );
    assert.equal(rows.length, 2); // nothing deleted
    const firstRow = rows.find((r) => r.id === first.id)!;
    const secondRow = rows.find((r) => r.id === second.id)!;
    assert.equal(firstRow.invalidatedAt, null); // earliest kept
    assert.ok(secondRow.invalidatedAt instanceof Date); // later retired
  });

  it("decays low-confidence learnings untouched for N days (user_told survives)", async () => {
    const ws = await freshWorkspace();
    await seedEpisode(ws);
    const old = new Date(Date.now() - 100 * 86400_000);
    const stale = await recordLearning(ws, {
      hypothesis: "A stale low-confidence guess from long ago",
      action: "seeded directly for the learning-pass test",
      result: "inconclusive",
      metricDelta: { confidence: 0.3 },
      contextRefs: { origin: "agent_inferred" },
      observedAt: old,
      source: "consolidation",
    });
    const userTold = await recordLearning(ws, {
      hypothesis: "The user told us to always use Oxford commas",
      action: "seeded directly for the learning-pass test",
      result: "worked",
      metricDelta: { confidence: 0.2 },
      contextRefs: { origin: "user_told" },
      observedAt: old,
      source: "consolidation",
    });
    const report = await executeLearningPass(ws, {
      llm: mockLlmJson({ lessons: [], voiceProposal: null, knowledge: [], styleRules: [] }),
      modelLabel: "test",
      decayDays: 90,
    });
    assert.ok(report.learningsDecayed >= 1);
    const rows = await withWorkspaceScope(ws, async (tx) =>
      tx.memoryLearning.findMany({
        where: { workspaceId: ws, id: { in: [stale.id, userTold.id] } },
        select: { id: true, invalidatedAt: true },
      }),
    );
    assert.ok(rows.find((r) => r.id === stale.id)!.invalidatedAt instanceof Date);
    assert.equal(rows.find((r) => r.id === userTold.id)!.invalidatedAt, null);
  });
});

describe("learning-pass: paused + nightly guards", () => {
  it("skips workspaces with learning paused", async () => {
    const ws = await freshWorkspace();
    await seedEpisode(ws);
    await setLearningPaused(ws, true);
    const report = await executeLearningPass(ws, {
      llm: mockLlmJson(FULL_PAYLOAD),
      modelLabel: "test",
    });
    assert.equal(report.status, "skipped_paused");
    assert.equal(report.learningsExtracted, 0);
    assert.equal(report.llmUsage, null); // no LLM call was made
    const rows = await withWorkspaceScope(ws, async (tx) =>
      tx.memoryLearning.count({ where: { workspaceId: ws } }),
    );
    assert.equal(rows, 0);
    await setLearningPaused(ws, false);
  });

  it("runs at most one LLM pass per workspace per night", async () => {
    const ws = await freshWorkspace();
    await seedEpisode(ws);
    // Simulate tonight's already-completed pass via run-row bookkeeping.
    const runId = await startConsolidationRun(ws);
    await withWorkspaceScope(ws, async (tx) => {
      await tx.memoryConsolidationRun.update({
        where: { id: runId },
        data: {
          status: "succeeded",
          finishedAt: new Date(),
          error: JSON.stringify({
            distilledIds: [],
            learningPass: { status: "ran", at: new Date().toISOString() },
          }),
        },
      });
    });
    let llmCalled = false;
    const report = await executeLearningPass(ws, {
      llm: async () => {
        llmCalled = true;
        return JSON.stringify(FULL_PAYLOAD);
      },
      modelLabel: "test",
    });
    assert.equal(report.status, "skipped_already_ran");
    assert.equal(llmCalled, false);
  });

  it("skips when there is no material", async () => {
    const ws = await freshWorkspace();
    const report = await executeLearningPass(ws, {
      llm: mockLlmJson(FULL_PAYLOAD),
      modelLabel: "test",
    });
    assert.equal(report.status, "skipped_no_material");
  });
});

describe("learning-pass: intelligence write-back as reviewable diffs", () => {
  it("writes voice proposals to pendingUpdates with the contract shape", async () => {
    const ws = await freshWorkspace();
    await seedEpisode(ws);
    await seedVoiceProfile(ws, false);
    const report = await executeLearningPass(ws, {
      llm: mockLlmJson({ lessons: [], voiceProposal: VOICE_PROPOSAL, knowledge: [], styleRules: [] }),
      modelLabel: "test",
    });
    assert.equal(report.voiceProposed, 1);
    const profile = await withWorkspaceScope(ws, async (tx) =>
      tx.brandVoiceProfile.findUnique({
        where: { workspaceId: ws },
        select: { dimensions: true, pendingUpdates: true, pinnedByUser: true },
      }),
    );
    assert.ok(profile);
    // Live dimensions untouched — proposal only.
    assert.deepEqual(profile!.dimensions, {
      vocabulary: [],
      rhythm: "varied",
      formality: "neutral",
      pov: "third person",
      humor: "none",
      doExamples: [],
      dontExamples: [],
    });
    const pending = profile!.pendingUpdates as {
      proposedAt: string;
      dimensions: Record<string, unknown>;
      rationale: string;
    };
    assert.ok(pending);
    assert.ok(!Number.isNaN(Date.parse(pending.proposedAt)));
    assert.deepEqual(pending.dimensions, VOICE_PROPOSAL.dimensions);
    assert.equal(pending.rationale, VOICE_PROPOSAL.rationale);
  });

  it("never touches a user-pinned voice profile", async () => {
    const ws = await freshWorkspace();
    await seedEpisode(ws);
    await seedVoiceProfile(ws, true);
    const before = await withWorkspaceScope(ws, async (tx) =>
      tx.brandVoiceProfile.findUnique({
        where: { workspaceId: ws },
        select: { dimensions: true, pendingUpdates: true },
      }),
    );
    const report = await executeLearningPass(ws, {
      llm: mockLlmJson({ lessons: [], voiceProposal: VOICE_PROPOSAL, knowledge: [], styleRules: [] }),
      modelLabel: "test",
    });
    assert.equal(report.voiceProposed, 0);
    const afterProfile = await withWorkspaceScope(ws, async (tx) =>
      tx.brandVoiceProfile.findUnique({
        where: { workspaceId: ws },
        select: { dimensions: true, pendingUpdates: true },
      }),
    );
    assert.deepEqual(afterProfile, before);
  });

  it("creates knowledge rows with needsReview and inactive style rules", async () => {
    const ws = await freshWorkspace();
    await seedEpisode(ws);
    const report = await executeLearningPass(ws, {
      llm: mockLlmJson({ lessons: [], voiceProposal: null, knowledge: FULL_PAYLOAD.knowledge, styleRules: FULL_PAYLOAD.styleRules }),
      modelLabel: "test",
    });
    assert.equal(report.knowledgeProposed, 1);
    assert.equal(report.styleRulesProposed, 1);

    const knowledge = await withWorkspaceScope(ws, async (tx) =>
      tx.companyKnowledge.findMany({
        where: { workspaceId: ws },
        select: { kind: true, title: true, body: true, pinned: true, confidence: true },
      }),
    );
    assert.equal(knowledge.length, 1);
    assert.equal(knowledge[0].kind, "product");
    assert.equal(knowledge[0].pinned, false);
    assert.equal((knowledge[0].body as { needsReview: boolean }).needsReview, true);
    assert.equal((knowledge[0].body as { summary: string }).summary, "Entry tier for small teams");

    const rules = await withWorkspaceScope(ws, async (tx) =>
      tx.styleRule.findMany({
        where: { workspaceId: ws },
        select: { kind: true, pattern: true, replacement: true, severity: true, active: true, pinned: true, source: true },
      }),
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].kind, "ban");
    assert.equal(rules[0].active, false); // proposal only — live on user accept
    assert.equal(rules[0].pinned, false);
    assert.equal(rules[0].source, "consolidation");
    assert.equal(rules[0].severity, "flag");
  });
});

describe("learning-pass: pure helpers", () => {
  it("parses fenced JSON and rejects garbage", () => {
    const fenced = "```json\n" + JSON.stringify(FULL_PAYLOAD) + "\n```";
    const parsed = parseLearningPassOutput(fenced);
    assert.ok(parsed);
    assert.equal(parsed!.lessons.length, 2);
    assert.equal(parsed!.lessons[0].confidence, 0.85);
    assert.ok(parsed!.voiceProposal);
    assert.equal(parsed!.knowledge.length, 1);
    assert.equal(parsed!.styleRules.length, 1);
    assert.equal(parseLearningPassOutput("not json at all"), null);
    assert.equal(parseLearningPassOutput(""), null);
  });

  it("textSimilarity behaves sanely", () => {
    assert.equal(textSimilarity("Always lead with the number", "always lead with the number"), 1);
    assert.ok(textSimilarity("always lead with the number; cut fluffy intros", "always lead with the number and cut fluffy intros") >= 0.75);
    assert.ok(textSimilarity("completely unrelated sentence about boats", "always lead with the number") < 0.5);
    assert.equal(textSimilarity("", "something"), 0);
    assert.ok(normalizeLearningText("  Hello, World!  ") === "hello world");
  });
});
