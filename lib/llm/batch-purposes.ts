// ShapesOS — Phase 17 (A4, WS=model): the Message Batches delivery handlers.
// One entry per purpose; imported by the `llm_batch` job handler and by the
// code that submits (so a purpose is always registered before it is used).

import { registerBatchPurpose } from "./batch";

/** The nightly learning pass (lib/substrate/memory/learning-pass.ts). */
registerBatchPurpose("learning_pass", async ({ workspaceId, context, results, model }) => {
  const r = results.pass;
  if (!r || "error" in r) {
    console.warn(`[learning-pass] workspace ${workspaceId}: batch result missing or failed (${r && "error" in r ? r.error : "no result"}) — nothing written.`);
    return;
  }
  const { applyLearningPassOutput } = await import("@/lib/substrate/memory/learning-pass");
  const c = (context ?? {}) as { dateLabel?: string; threshold?: number; decayDays?: number; decayConfidence?: number };
  const { learningSimilarityThreshold, learningDecayDays, learningDecayConfidence } = await import("@/lib/substrate/memory/learning-pass");
  const report = await applyLearningPassOutput(workspaceId, r.text, model ?? "batch", {
    dateLabel: c.dateLabel ?? new Date().toISOString().slice(0, 10),
    threshold: c.threshold ?? learningSimilarityThreshold(),
    decayDays: c.decayDays ?? learningDecayDays(),
    decayConfidence: c.decayConfidence ?? learningDecayConfidence(),
  });
  console.log(`[learning-pass] workspace ${workspaceId}: batch delivered — ${report.learningsExtracted} lessons, status ${report.status}.`);
});
