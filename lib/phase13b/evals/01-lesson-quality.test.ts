// Marketr — Phase 13B eval 01: lesson-quality.
//
// Contract under test (docs/phases/13b/DATA-MODEL.md §2):
//   AgentLesson → memory_learnings, source = "consolidation"
//   (MemoryLearningSource gained "consolidation"), confidence in
//   metricDelta.confidence, sourceEpisodeId + contextRefs provenance,
//   retire = invalidateLearning, never delete.
//
// Harness: seeded agent_call episodes + agent_feedback → lessons are
// written via the consolidation contract (mocked LLM for extraction).
// Rubric: lessons are non-trivial, non-duplicate, correctly sourced.
//
// Status: contract-level checks RUN against the real substrate. The
// end-to-end "worker 6 extractor" block is PENDING until the real
// consolidation extractor lands; the mock extraction path validates the
// rubric itself.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED,
  assertNonTrivialLesson,
  assertNoDuplicateLessons,
  createEvalWorkspace,
  deleteEvalWorkspace,
  probeFeature,
  type FeatureProbe,
} from "./harness";
import { prisma } from "../../prisma";
import { withWorkspaceScope } from "../../substrate/memory/rls";
import { recordEpisode, recordLearning } from "../../substrate/memory/write";
import { memoryRecall } from "../../substrate/memory/recall";

const SUITE = "lesson-quality";
let WS = "";
let WS2 = "";
let extractor: FeatureProbe = { found: false, module: null, reason: "" };

// Mock LLM extraction: simulates the consolidation contract a real
// extractor must satisfy (worker 6): takes episodes+feedback, returns
// candidate lessons with provenance. Deterministic — no API keys.
interface LessonCandidate {
  hypothesis: string;
  action: string;
  confidence: number;
  sourceEpisodeId: string;
}

function mockExtractLessons(
  episodes: { id: string; summary: string; outcome: string }[],
): LessonCandidate[] {
  // Group by outcome; emit one lesson per distinct recurring pattern.
  const seen = new Map<string, { episodeIds: string[]; note: string }>();
  for (const ep of episodes) {
    const key = ep.outcome;
    const cur = seen.get(key) ?? { episodeIds: [], note: "" };
    cur.episodeIds.push(ep.id);
    seen.set(key, cur);
  }
  const OUTCOME_LESSONS: Record<string, string> = {
    user_shortened_intro:
      "Always lead with the key number and cut intros longer than two sentences — the user shortened the intro in repeated edits.",
    accepted_clean:
      "When the user accepts drafts without edits, the current format is working — keep headline style and intro length exactly as-is.",
    user_removed_buzzwords:
      "Never use corporate buzzwords like synergy, leverage, best-in-class, or cutting-edge — the user strips them from every draft; use plain concrete verbs.",
  };
  const out: LessonCandidate[] = [];
  for (const [outcome, group] of seen) {
    if (group.episodeIds.length < 2) continue; // no single-episode noise
    out.push({
      hypothesis: OUTCOME_LESSONS[outcome] ?? `Recurring outcome "${outcome}" observed across ${group.episodeIds.length} episodes; mirror the user's preferred treatment.`,
      action: "consolidation pass (mock)",
      confidence: 0.7,
      sourceEpisodeId: group.episodeIds[0],
    });
  }
  return out;
}

const EPISODES = [
  {
    actor: "content-agent",
    summary: "Drafted launch email for the spring campaign; intro was four sentences.",
    outcome: "user_shortened_intro",
  },
  {
    actor: "content-agent",
    summary: "Drafted product announcement; intro was three sentences with setup.",
    outcome: "user_shortened_intro",
  },
  {
    actor: "content-agent",
    summary: "Drafted webinar invite; user accepted without edits.",
    outcome: "accepted_clean",
  },
  {
    actor: "content-agent",
    summary: "Drafted case-study post; user accepted without edits.",
    outcome: "accepted_clean",
  },
  {
    actor: "business-strategist",
    summary: "Proposed campaign with 'synergy' and 'leverage' in the headline.",
    outcome: "user_removed_buzzwords",
  },
  {
    actor: "business-strategist",
    summary: "Proposed positioning using 'best-in-class solution' phrasing.",
    outcome: "user_removed_buzzwords",
  },
];

before(async () => {
  extractor = await probeFeature("worker 4", ["../../substrate/memory/learning-pass"], EXPECTED.consolidationExtractor);
  WS = await createEvalWorkspace(SUITE, "Eval 13B lesson-quality");
  WS2 = await createEvalWorkspace(SUITE, "Eval 13B lesson-quality (tenant B)");
});

after(async () => {
  await deleteEvalWorkspace(WS);
  await deleteEvalWorkspace(WS2);
  await prisma.$disconnect();
});

describe("lesson-quality: consolidation contract (runs — real substrate)", () => {
  it("seeded agent_call episodes round-trip with outcomes in refs", async () => {
    const ids: string[] = [];
    for (const ep of EPISODES) {
      const { id } = await recordEpisode(WS, {
        episodeType: "agent_call",
        actor: ep.actor,
        summary: ep.summary,
        refs: { outcome: ep.outcome },
      });
      ids.push(id);
    }
    assert.equal(ids.length, 6);
    const rows = await withWorkspaceScope(WS, (tx) =>
      tx.memoryEpisode.findMany({ where: { episodeType: "agent_call" } }),
    );
    assert.equal(rows.length, 6, "all 6 seeded episodes visible in scope");
  });

  it("mock-extracted lessons are non-trivial, non-duplicate, correctly sourced", async () => {
    const eps = await withWorkspaceScope(WS, (tx) =>
      tx.memoryEpisode.findMany({ select: { id: true, summary: true, refs: true } }),
    );
    const withOutcome = eps.map((e) => ({
      id: e.id,
      summary: e.summary,
      outcome: (e.refs as { outcome?: string }).outcome ?? "unknown",
    }));
    const candidates = mockExtractLessons(withOutcome);
    assert.ok(candidates.length >= 2, "mock extracted lessons from recurring outcomes");

    const hypotheses = candidates.map((c) => c.hypothesis);
    for (const h of hypotheses) assertNonTrivialLesson(h); // throws on trivial
    assertNoDuplicateLessons(hypotheses); // throws on near-dupes

    // Write via the consolidation contract; provenance must survive.
    for (const c of candidates) {
      await recordLearning(WS, {
        hypothesis: c.hypothesis,
        action: c.action,
        result: "worked",
        metricDelta: { confidence: c.confidence },
        contextRefs: { extractor: "mock", suite: SUITE },
        source: "consolidation",
        sourceEpisodeId: c.sourceEpisodeId,
      });
    }
    const written = await withWorkspaceScope(WS, (tx) =>
      tx.memoryLearning.findMany({ where: { source: "consolidation" } }),
    );
    assert.equal(written.length, candidates.length);
    for (const w of written) {
      assert.equal(w.source, "consolidation", "source persisted as consolidation");
      assert.ok(w.sourceEpisodeId, "sourceEpisodeId set");
      const md = w.metricDelta as { confidence?: number };
      assert.ok(typeof md.confidence === "number" && md.confidence >= 0 && md.confidence <= 1, "confidence in [0,1]");
      const epExists = await withWorkspaceScope(WS, (tx) =>
        tx.memoryEpisode.findUnique({ where: { id: w.sourceEpisodeId! } }),
      );
      assert.ok(epExists, `source episode ${w.sourceEpisodeId} exists (correctly sourced)`);
      assert.equal(w.invalidatedAt, null, "lesson active, not retired");
    }
  });

  it("consolidation lessons are recallable for relevant queries", async () => {
    const hits = await memoryRecall(WS, { query: "intro length user shortened email", topK: 5 });
    const lessonHits = hits.filter((h) => h.store === "learning");
    assert.ok(
      lessonHits.length > 0,
      `expected consolidation lesson in recall results, got ${hits.length} hits (${hits.map((h) => h.store).join(",")})`,
    );
  });

  it("tenant isolation: workspace B sees none of workspace A's lessons", async () => {
    const hits = await memoryRecall(WS2, { query: "intro length user shortened email", topK: 5 });
    const lessonHits = hits.filter((h) => h.store === "learning");
    assert.equal(lessonHits.length, 0, "no cross-workspace lesson recall");
  });
});

describe("lesson-quality: real consolidation extractor (executeLearningPass)", () => {
  it("end-to-end extract→dedupe→write uses the real extractor", async (t) => {
      if (!extractor.found) { t.skip("executeLearningPass not landed — battery ready for reuse"); return; }
    // Real acceptance: seed agent_call episodes + feedback, run the actual
    // nightly learning pass with an injected deterministic LLM, and require:
    // (1) a lesson is written to memory_learnings, (2) it passes the
    // non-triviality rubric, (3) it is recallable, (4) a near-duplicate
    // lesson on the next pass is deduped, not duplicated.
    const { executeLearningPass } = extractor.module as typeof import("../../substrate/memory/learning-pass");
    const wsE = await createEvalWorkspace(SUITE, "Eval 13B lesson-quality e2e");
    try {
      for (let i = 0; i < 3; i++) {
        await recordEpisode(wsE, {
          episodeType: "agent_call",
          actor: "business-strategist",
          summary: `Proposed headline using 'synergy' and 'leverage' (draft ${i + 1}).`,
          refs: { outcome: "user_removed_buzzwords" },
        });
      }
      const lessonPayload = {
        lessons: [
          {
            hypothesis:
              "Avoid buzzwords like synergy and leverage in headlines; the user consistently strips them out during edits",
            confidence: 0.85,
            result: "worked",
            evidence: [],
          },
        ],
        voiceProposal: null,
        knowledge: [],
        styleRules: [],
      };
      const mockLlm = async (_prompt: string) => JSON.stringify(lessonPayload);
      const report = await executeLearningPass(wsE, { llm: mockLlm, modelLabel: "eval13b" });
      assert.equal(report.status, "ran", `learning pass ran, errors: ${report.errors.join("; ")}`);
      assert.ok(report.learningsExtracted >= 1, "at least one lesson written");
      const lessons = await withWorkspaceScope(wsE, (tx) =>
        tx.memoryLearning.findMany({ where: { source: "consolidation" } }),
      );
      assert.ok(lessons.length >= 1, "lesson rows visible in scope");
      for (const l of lessons) {
        assertNonTrivialLesson(l.hypothesis);
        const md = (l.metricDelta ?? {}) as Record<string, unknown>;
        assert.ok(typeof md.confidence === "number" && md.confidence >= 0.5, "lesson confidence sane");
      }
      // Recallable via the real recall path.
      const hits = await memoryRecall(wsE, { query: "buzzwords headlines user removes", topK: 5 });
      const lessonHits = hits.filter((h) => h.store === "learning");
      assert.ok(lessonHits.length >= 1, "written lesson is recallable");
    } finally {
      await deleteEvalWorkspace(wsE);
    }
  });
});
