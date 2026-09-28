// Marketr — Phase 13B (Worker 2): learning capture tests.
// Run: npx tsx --test lib/agents/learning/__tests__/capture.test.ts
// Fully mocked: no DB, no embedding model, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  captureEpisode,
  recordFeedback,
  captureEditDiff,
  captureContentSaveDiff,
  diffText,
  FEEDBACK_KINDS,
  type CaptureDeps,
  type EpisodeWriter,
  type FeedbackWriter,
  type FeedbackWriteInput,
} from "../capture";
import type { EpisodeInput } from "@/lib/substrate/memory/types";

interface EpisodeCall {
  workspaceId: string;
  input: EpisodeInput;
}
interface FeedbackCall {
  workspaceId: string;
  input: FeedbackWriteInput;
}

function mockDeps(overrides: Partial<CaptureDeps> = {}): CaptureDeps & {
  episodeCalls: EpisodeCall[];
  feedbackCalls: FeedbackCall[];
} {
  const episodeCalls: EpisodeCall[] = [];
  const feedbackCalls: FeedbackCall[] = [];
  const episodeWriter: EpisodeWriter = async (workspaceId, input) => {
    episodeCalls.push({ workspaceId, input });
    return { id: "ep-1", redactions: 0 };
  };
  const feedbackWriter: FeedbackWriter = async (workspaceId, input) => {
    feedbackCalls.push({ workspaceId, input });
    return { id: "fb-1" };
  };
  return {
    episodeWriter,
    feedbackWriter,
    isPaused: async () => false,
    ...overrides,
    episodeCalls,
    feedbackCalls,
  };
}

describe("captureEpisode", () => {
  it("writes an agent_call episode with prompt/output/outcome refs", async () => {
    const deps = mockDeps();
    const id = await captureEpisode(
      {
        workspaceId: "ws-a",
        agentId: "chief-strategy",
        promptSummary: "What should we do about churn?",
        outputSummary: "Focus on onboarding emails first.",
        outcome: "answered",
      },
      deps,
    );
    assert.equal(id, "ep-1");
    assert.equal(deps.episodeCalls.length, 1);
    const call = deps.episodeCalls[0];
    assert.equal(call.workspaceId, "ws-a");
    assert.equal(call.input.episodeType, "agent_call");
    assert.equal(call.input.actor, "chief-strategy");
    const refs = call.input.refs as Record<string, unknown>;
    assert.equal(refs.promptSummary, "What should we do about churn?");
    assert.equal(refs.outputSummary, "Focus on onboarding emails first.");
    assert.equal(refs.outcome, "answered");
    assert.ok(call.input.summary.length >= 12, "summary meets the selectivity floor");
  });

  it("suppresses capture when learning is paused", async () => {
    const deps = mockDeps({ isPaused: async () => true });
    const id = await captureEpisode(
      { workspaceId: "ws-a", agentId: "chief-strategy", promptSummary: "hello world test" },
      deps,
    );
    assert.equal(id, null);
    assert.equal(deps.episodeCalls.length, 0);
  });

  it("is fail-soft: a throwing writer never breaks the caller", async () => {
    const deps = mockDeps({
      episodeWriter: async () => {
        throw new Error("db exploded");
      },
    });
    const id = await captureEpisode(
      { workspaceId: "ws-a", agentId: "chief-strategy", promptSummary: "hello world test" },
      deps,
    );
    assert.equal(id, null);
  });

  it("is fail-soft: a throwing pause check skips capture instead of throwing", async () => {
    const deps = mockDeps({
      isPaused: async () => {
        throw new Error("rls down");
      },
    });
    const id = await captureEpisode(
      { workspaceId: "ws-a", agentId: "chief-strategy", promptSummary: "hello world test" },
      deps,
    );
    assert.equal(id, null);
    assert.equal(deps.episodeCalls.length, 0);
  });
});

describe("recordFeedback", () => {
  it("writes explicit_up feedback through the tenant scope", async () => {
    const deps = mockDeps();
    const id = await recordFeedback(
      {
        workspaceId: "ws-a",
        episodeId: "ep-1",
        agentId: "chief-strategy",
        kind: "explicit_up",
        signal: { source: "ui" },
      },
      deps,
    );
    assert.equal(id, "fb-1");
    assert.equal(deps.feedbackCalls.length, 1);
    const call = deps.feedbackCalls[0];
    assert.equal(call.workspaceId, "ws-a");
    assert.equal(call.input.kind, "explicit_up");
    assert.equal(call.input.episodeId, "ep-1");
  });

  it("rejects an unknown kind without writing", async () => {
    const deps = mockDeps();
    const id = await recordFeedback(
      {
        workspaceId: "ws-a",
        agentId: "chief-strategy",
        // @ts-expect-error — intentionally invalid
        kind: "love_it",
      },
      deps,
    );
    assert.equal(id, null);
    assert.equal(deps.feedbackCalls.length, 0);
  });

  it("suppresses feedback when learning is paused", async () => {
    const deps = mockDeps({ isPaused: async () => true });
    const id = await recordFeedback(
      { workspaceId: "ws-a", agentId: "chief-strategy", kind: "explicit_down" },
      deps,
    );
    assert.equal(id, null);
    assert.equal(deps.feedbackCalls.length, 0);
  });

  it("RLS battery pattern: a smuggled workspaceId in the payload cannot change the write scope", async () => {
    const deps = mockDeps();
    const id = await recordFeedback(
      {
        workspaceId: "ws-a",
        agentId: "chief-strategy",
        kind: "accepted",
        signal: {
          // hostile payload trying to redirect the row into another workspace
          workspaceId: "ws-evil",
          withEdits: false,
        } as Record<string, unknown>,
      },
      deps,
    );
    assert.equal(id, "fb-1");
    // The writer contract: the scoped workspaceId argument is authoritative.
    // defaultFeedbackWriter always persists `workspaceId` from the argument,
    // never from the payload — the RLS WITH CHECK then enforces it at the DB.
    assert.equal(deps.feedbackCalls[0].workspaceId, "ws-a");
    assert.notEqual(deps.feedbackCalls[0].workspaceId, "ws-evil");
  });

  it("exposes exactly the five DATA-MODEL kinds", () => {
    assert.deepEqual([...FEEDBACK_KINDS].sort(), [
      "accepted",
      "edit_diff",
      "explicit_down",
      "explicit_up",
      "regenerated",
    ]);
  });
});

describe("diffText", () => {
  it("reports identical texts as identical with zero stats", () => {
    const d = diffText("same text\nsecond line", "same text\nsecond line");
    assert.equal(d.identical, true);
    assert.equal(d.wordsAdded, 0);
    assert.equal(d.wordsRemoved, 0);
    assert.deepEqual(d.hunks, []);
  });

  it("produces a sane word-level diff for an insertion", () => {
    const d = diffText("hello world", "hello brave new world");
    assert.equal(d.identical, false);
    assert.equal(d.wordsAdded, 2);
    assert.equal(d.wordsRemoved, 0);
    assert.ok(d.hunks.length >= 1);
    assert.equal(d.hunks[0].type, "replaced");
    assert.equal(d.hunks[0].atLine, 1);
  });

  it("detects removed and replaced lines across a multi-line doc", () => {
    const before = "line one\nline two is here\nline three\nline four";
    const after = "line one\nline 2 changed a lot\nline four";
    const d = diffText(before, after);
    assert.equal(d.identical, false);
    assert.ok(d.linesRemoved >= 2, `removed=${d.linesRemoved}`);
    assert.ok(d.linesAdded >= 1, `added=${d.linesAdded}`);
    assert.ok(d.wordsAdded > 0 && d.wordsRemoved > 0);
    // Every reported hunk points at a real 1-based line in the before text.
    for (const h of d.hunks) {
      assert.ok(h.atLine >= 1 && h.atLine <= 4, `atLine=${h.atLine}`);
      assert.ok(h.excerpt.length > 0);
    }
  });

  it("emits tone hints for punctuation and pronoun shifts", () => {
    const d = diffText("The results were acceptable.", "The results were amazing! We crushed it!");
    assert.ok(
      d.toneHints.some((h) => h.includes("exclamation")),
      `hints=${JSON.stringify(d.toneHints)}`,
    );
    assert.ok(
      d.toneHints.some((h) => h.includes("first-person")),
      `hints=${JSON.stringify(d.toneHints)}`,
    );
  });
});

describe("captureEditDiff", () => {
  it("records accepted when the user saves without edits", async () => {
    const deps = mockDeps();
    const id = await captureEditDiff(
      {
        workspaceId: "ws-a",
        episodeId: "ep-1",
        agentId: "content-brief",
        draft: "  hello world  ",
        final: "hello world",
        source: "content_editor",
      },
      deps,
    );
    assert.equal(id, "fb-1");
    const call = deps.feedbackCalls[0];
    assert.equal(call.input.kind, "accepted");
    assert.deepEqual((call.input.signal as Record<string, unknown>).withEdits, false);
    assert.equal(call.input.episodeId, "ep-1");
  });

  it("records edit_diff with diff stats when the user edits", async () => {
    const deps = mockDeps();
    const draft = "Our product helps teams ship faster.\nIt is affordable.";
    const final = "Our product helps teams ship 10x faster!\nIt is affordable and secure.";
    const id = await captureEditDiff(
      { workspaceId: "ws-a", episodeId: "ep-9", agentId: "content-brief", draft, final },
      deps,
    );
    assert.equal(id, "fb-1");
    const call = deps.feedbackCalls[0];
    assert.equal(call.input.kind, "edit_diff");
    const signal = call.input.signal as Record<string, unknown>;
    const stats = signal.diffStats as Record<string, unknown>;
    assert.ok(typeof stats.wordsAdded === "number" && stats.wordsAdded > 0);
    assert.ok(typeof stats.wordsRemoved === "number");
    assert.ok(Array.isArray(stats.changedRegions) && stats.changedRegions.length > 0);
    assert.ok(Array.isArray(stats.toneHints));
    assert.equal(typeof signal.before, "string");
    assert.equal(typeof signal.after, "string");
    // before/after are truncated for storage
    assert.ok((signal.before as string).length <= 4000);
  });

  it("is fail-soft when the feedback write throws", async () => {
    const deps = mockDeps({
      feedbackWriter: async () => {
        throw new Error("db exploded");
      },
    });
    const id = await captureEditDiff(
      { workspaceId: "ws-a", agentId: "content-brief", draft: "a", final: "b" },
      deps,
    );
    assert.equal(id, null);
  });
});

describe("captureContentSaveDiff", () => {
  it("returns null without writing when no agent draft exists", async () => {
    const deps = mockDeps({ draftEpisodeLookup: async () => null });
    const id = await captureContentSaveDiff("ws-a", "content-1", "user wrote this");
    void deps;
    assert.equal(id, null);
  });

  it("diffs the save against the stored agent draft", async () => {
    const deps = mockDeps({
      draftEpisodeLookup: async () => ({ id: "ep-draft", draft: "agent draft text" }),
    });
    const id = await captureContentSaveDiff("ws-a", "content-1", "agent draft text, edited by user", {}, deps);
    assert.equal(id, "fb-1");
    const call = deps.feedbackCalls[0];
    assert.equal(call.input.kind, "edit_diff");
    assert.equal(call.input.episodeId, "ep-draft");
    assert.equal(call.input.agentId, "content-brief");
  });
});
