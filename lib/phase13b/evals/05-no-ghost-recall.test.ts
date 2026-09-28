// Marketr — Phase 13B eval 05: no-ghost-recall.
//
// Contract under test (docs/phases/13b/DATA-MODEL.md + write.ts discipline):
//   - memory_learnings: retire = invalidateLearning (invalidatedAt set),
//     NEVER delete; recall excludes invalidated rows for current time.
//   - memory_facts: updates = supersede chain (invalidAt/expiredAt +
//     supersededById); getPreference returns only the latest.
//   - memory_episodes: IMMUTABLE — no update/delete path exists by design
//     (updateEpisode throws); recall must still find them.
//
// Acceptance: create lesson → delete (retire) via the API → recall/query
// must never return it again — verified across all three stores.
//
// Status: fully runnable against the real substrate. Expected PASS.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createEvalWorkspace, deleteEvalWorkspace } from "./harness";
import { prisma } from "../../prisma";
import { withWorkspaceScope } from "../../substrate/memory/rls";
import {
  recordEpisode,
  recordLearning,
  invalidateLearning,
  updateEpisode,
} from "../../substrate/memory/write";
import { memoryRecall } from "../../substrate/memory/recall";
import {
  PREF_KEYS,
  getPreferenceScoped,
  setPreference,
} from "../../substrate/memory/preferences";

const SUITE = "no-ghost-recall";
let WS = "";
let WS2 = "";

before(async () => {
  WS = await createEvalWorkspace(SUITE, "Eval 13B no-ghost-recall");
  WS2 = await createEvalWorkspace(SUITE, "Eval 13B no-ghost-recall (tenant B)");
});

after(async () => {
  await deleteEvalWorkspace(WS);
  await deleteEvalWorkspace(WS2);
  await prisma.$disconnect();
});

describe("no-ghost-recall: learnings (retire ≠ delete)", () => {
  it("retired lesson never returns from recall, but the row survives (audit)", async () => {
    const { id: lessonId } = await recordLearning(WS, {
      hypothesis: "The agent should always open campaign briefs with the primary KPI in bold.",
      action: "consolidation pass 2026-09-27",
      result: "worked",
      metricDelta: { confidence: 0.8 },
      contextRefs: { suite: SUITE },
      source: "consolidation",
    });

    const before = await memoryRecall(WS, { query: "campaign brief primary KPI bold opening", topK: 10 });
    assert.ok(
      before.some((h) => h.refId === lessonId),
      "lesson recallable before retirement",
    );

    await invalidateLearning(WS, lessonId, "User corrected: only for paid campaigns, not organic.");

    const after = await memoryRecall(WS, { query: "campaign brief primary KPI bold opening", topK: 10 });
    assert.ok(
      !after.some((h) => h.refId === lessonId),
      "retired lesson must NOT appear in recall results",
    );

    // Retire ≠ delete: the row survives with invalidatedAt for its era.
    const row = await withWorkspaceScope(WS, (tx) =>
      tx.memoryLearning.findUnique({ where: { id: lessonId } }),
    );
    assert.ok(row, "retired row still exists (audit trail)");
    assert.ok(row!.invalidatedAt instanceof Date, "invalidatedAt set");
    assert.ok(
      ((row!.contextRefs as Record<string, unknown>).invalidationReason as string).length > 0,
      "invalidation reason recorded",
    );
  });

  it("invalidating a lesson in workspace A does not affect workspace B", async () => {
    const { id } = await recordLearning(WS2, {
      hypothesis: "Workspace B lesson about email subject lines under 40 characters.",
      action: "consolidation pass 2026-09-27",
      result: "worked",
      metricDelta: { confidence: 0.6 },
      source: "consolidation",
    });
    await invalidateLearning(WS2, id, "superseded by newer guidance");
    const hits = await memoryRecall(WS, { query: "email subject lines under 40 characters", topK: 10 });
    assert.ok(!hits.some((h) => h.refId === id), "no cross-workspace ghost recall");
  });
});

describe("no-ghost-recall: facts / preferences (supersede chain)", () => {
  it("superseded preference value never surfaces via the API", async () => {
    await setPreference(WS, PREF_KEYS.detailLevel, "verbose", { origin: "user_told", confidence: 0.8 });
    await setPreference(WS, PREF_KEYS.detailLevel, "terse", { origin: "user_told", confidence: 0.9 });

    const pref = await getPreferenceScoped(WS, PREF_KEYS.detailLevel);
    assert.equal(pref!.value, "terse", "only the latest value is returned");
    assert.notEqual(pref!.value, "verbose", "old value never surfaces");

    // Old row is invalidated, not deleted — history queryable, API blind.
    const rows = await withWorkspaceScope(WS, (tx) =>
      tx.memoryFact.findMany({ where: { predicate: `pref:${PREF_KEYS.detailLevel}` } }),
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.invalidAt !== null), "superseded row invalidated");
  });
});

describe("no-ghost-recall: episodes (immutable by design)", () => {
  it("episodes have no delete path — and recall still finds them", async () => {
    const { id } = await recordEpisode(WS, {
      episodeType: "agent_call",
      actor: "business-strategist",
      summary: "Proposed the Q4 keyword plan targeting commercial-intent terms.",
      refs: { outcome: "accepted_clean" },
    });
    assert.throws(() => updateEpisode(), /immutable|no update path/i, "updateEpisode fails loudly by design");
    const hits = await memoryRecall(WS, { query: "Q4 keyword plan commercial intent", topK: 5 });
    assert.ok(hits.some((h) => h.refId === id), "immutable episode still recallable");
  });
});
