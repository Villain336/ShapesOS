// Marketr — Phase 13B eval 07: feedback-diff sanity.
//
// Contract under test (docs/phases/13b/DATA-MODEL.md):
//   AgentFeedback → agent_feedback: episodeId? → memory_episodes (SetNull),
//   agentId, kind: FeedbackKind (explicit_up|explicit_down|edit_diff|
//   accepted|regenerated), signal: Json.
//   edit_diff → { before, after, diffStats }.
//
// Acceptance: seeded draft/final pairs → the edit-diff summary captures
// the real changes (e.g. "user shortened intro, removed buzzwords").
//
// Status: the seeded pairs + contract round-trip RUN. The pipeline's
// summarizeEditDiff is PENDING until worker 4 lands — the deterministic
// harness diff below validates FIXTURE quality (the designed changes are
// really detectable), not pipeline quality. FEEDBACK_DIFF_PAIRS is
// exported for worker 4's own tests.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED,
  createEvalWorkspace,
  deleteEvalWorkspace,
  probeFeature,
  wordDiff,
  type FeatureProbe,
} from "./harness";
import { prisma } from "../../prisma";
import type { FeedbackKind } from "@prisma/client";
import { withWorkspaceScope } from "../../substrate/memory/rls";
import { recordEpisode } from "../../substrate/memory/write";

const SUITE = "feedback-diff";
let WS = "";
let summarizer: FeatureProbe = { found: false, module: null, reason: "" };

export interface DiffPair {
  name: string;
  before: string;
  after: string;
  /** Tokens the summary MUST reflect as removed/added (lowercased). */
  mustCaptureRemoved: string[];
  mustCaptureAdded: string[];
  humanSummary: string;
}

/** Seeded draft/final pairs — the acceptance battery for worker 4. */
export const FEEDBACK_DIFF_PAIRS: DiffPair[] = [
  {
    name: "shortened-intro",
    before:
      "Welcome to our newsletter. This month has been an incredible journey for our team, and we are so excited to share everything with you. Here are the three keywords that moved this week.",
    after: "Here are the three keywords that moved this week.",
    mustCaptureRemoved: ["welcome", "incredible", "journey"],
    mustCaptureAdded: [],
    humanSummary: "user deleted the fluffy intro, kept only the substance",
  },
  {
    name: "removed-buzzwords",
    before:
      "Our best-in-class solution leverages cutting-edge synergy to disrupt your vertical.",
    after: "Our tool helps your team ship faster.",
    mustCaptureRemoved: ["best-in-class", "synergy"],
    mustCaptureAdded: ["ship"],
    humanSummary: "user removed buzzwords, replaced with plain language",
  },
  {
    name: "added-disclaimer",
    before: "Clients averaged 3.2x ROAS last quarter.",
    after:
      "Clients averaged 3.2x ROAS last quarter. Past performance does not guarantee future results.",
    mustCaptureRemoved: [],
    mustCaptureAdded: ["guarantee", "results"],
    humanSummary: "user appended the compliance disclaimer",
  },
  {
    name: "tone-rewrite",
    before:
      "Great question! We are absolutely thrilled to help you with this amazing opportunity.",
    after: "Here's the breakdown of your options.",
    mustCaptureRemoved: ["thrilled", "amazing"],
    mustCaptureAdded: ["breakdown"],
    humanSummary: "user stripped sycophantic tone, kept it direct",
  },
];

before(async () => {
  summarizer = await probeFeature("worker 4", ["../../agents/learning/capture"], EXPECTED.feedbackDiff);
  WS = await createEvalWorkspace(SUITE, "Eval 13B feedback-diff");
});

after(async () => {
  await deleteEvalWorkspace(WS);
  await prisma.$disconnect();
});

describe("feedback-diff: AgentFeedback contract (runs — real schema)", () => {
  it("edit_diff feedback round-trips { before, after, diffStats }", async () => {
    const { id: episodeId } = await recordEpisode(WS, {
      episodeType: "agent_call",
      actor: "content-agent",
      summary: "Drafted launch email; user edited before sending.",
      refs: { outcome: "edited" },
    });
    const pair = FEEDBACK_DIFF_PAIRS[0];
    const d = wordDiff(pair.before, pair.after);
    await withWorkspaceScope(WS, (tx) =>
      tx.agentFeedback.create({
        data: {
          workspaceId: WS,
          episodeId,
          agentId: "content-agent",
          kind: "edit_diff",
          signal: {
            before: pair.before,
            after: pair.after,
            diffStats: { removedWords: d.removedCount, addedWords: d.addedCount },
          },
        },
      }),
    );
    const rows = await withWorkspaceScope(WS, (tx) =>
      tx.agentFeedback.findMany({ where: { kind: "edit_diff" } }),
    );
    assert.equal(rows.length, 1);
    const sig = rows[0].signal as { before: string; after: string; diffStats: { removedWords: number; addedWords: number } };
    assert.equal(sig.before, pair.before);
    assert.equal(sig.after, pair.after);
    assert.ok(sig.diffStats.removedWords > sig.diffStats.addedWords, "intro deletion: more removed than added");
    assert.equal(rows[0].episodeId, episodeId, "feedback links to its source episode");
  });

  it("explicit_up/down + accepted + regenerated kinds persist", async () => {
    const kinds = ["explicit_up", "explicit_down", "accepted", "regenerated"] as const;
    for (const kind of kinds) {
      await withWorkspaceScope(WS, (tx) =>
        tx.agentFeedback.create({
          data: {
            workspaceId: WS,
            agentId: "content-agent",
            kind: kind as FeedbackKind,
            signal: kind === "accepted" ? { withEdits: false } : { source: "ui" },
          },
        }),
      );
    }
    const rows = await withWorkspaceScope(WS, (tx) => tx.agentFeedback.findMany());
    const seen = new Set<FeedbackKind>(rows.map((r) => r.kind));
    for (const k of [...kinds, "edit_diff"] as FeedbackKind[]) assert.ok(seen.has(k), `kind ${k} persisted`);
  });
});

describe("feedback-diff: fixture sanity via deterministic diff (runs — validates fixtures, not pipeline)", () => {
  for (const pair of FEEDBACK_DIFF_PAIRS) {
    it(`fixture "${pair.name}" really encodes its designed change`, () => {
      const d = wordDiff(pair.before, pair.after);
      const removed = d.removed.join(" ").toLowerCase();
      const added = d.added.join(" ").toLowerCase();
      for (const tok of pair.mustCaptureRemoved) {
        assert.ok(removed.includes(tok), `"${pair.name}": removed tokens must include "${tok}"`);
      }
      for (const tok of pair.mustCaptureAdded) {
        assert.ok(added.includes(tok), `"${pair.name}": added tokens must include "${tok}"`);
      }
    });
  }
});

describe("feedback-diff: summarizeEditDiff (real implementation)", () => {
  for (const pair of FEEDBACK_DIFF_PAIRS) {
    it(`pipeline summary captures "${pair.humanSummary}"`, async (t) => {
      if (!summarizer.found) { t.skip("summarizeEditDiff not landed — battery ready for reuse"); return; }
      // Real acceptance: the deterministic summary must reflect the designed
      // change (loose match on mustCaptureRemoved/mustCaptureAdded tokens).
      const mod = summarizer.module as typeof import("../../agents/learning/capture");
      const { summary, diffStats } = await mod.summarizeEditDiff(pair.before, pair.after);
      const low = summary.toLowerCase();
      assert.ok(summary.length > 20, "summary is substantive");
      assert.equal(diffStats.identical, false, "diff detected");
      for (const tok of pair.mustCaptureRemoved) {
        assert.ok(
          low.includes(tok) || diffStats.removedTokens.includes(tok),
          `"${pair.name}": summary/stats must reflect removed token "${tok}"`,
        );
      }
      for (const tok of pair.mustCaptureAdded) {
        assert.ok(
          low.includes(tok) || diffStats.addedTokens.includes(tok),
          `"${pair.name}": summary/stats must reflect added token "${tok}"`,
        );
      }
    });
  }
});
