// Phase 19B (WS=panel) — the memory stream (in-memory store; the pgvector
// store is covered by lib/panel/__tests__/store-db.test.ts).
// Ported from the prototype's test/transcripts.test.ts (9 cases). Relevance
// is now embedding similarity: these tests inject the labelled FAKE
// lexicalTestEmbedder (hashed bag of words) where the prototype used token
// overlap; production embeds with MiniLM. Plus the starvation fix.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkText, cosine, heuristicImportanceScorer, InMemoryMemoryStore, lexicalTestEmbedder, RECENCY_DECAY, type Transcript } from "../memory";

function t(id: string, text: string): Transcript {
  return { id, text, title: `Interview ${id}`, interviewee: "Test User", createdAt: Date.now() };
}

describe("transcript chunking", () => {
  it("stores the transcript verbatim and chunks it into interview nodes", async () => {
    const store = new InMemoryMemoryStore();
    const text = "word ".repeat(400).trim();
    const nodes = await store.addTranscript(t("t1", text));
    // 400 words, 120-word chunks stepping 100 → chunks at 0, 100, 200, 300.
    assert.equal(nodes.length, 4);
    assert.equal((await store.getTranscript("t1"))?.text, text);
    for (const n of nodes) {
      assert.equal(n.transcriptId, "t1");
      assert.equal(n.kind, "interview");
      assert.ok(n.importance >= 0 && n.importance <= 1);
    }
    assert.equal(store.nodeCount, 4);
  });

  it("returns no nodes for empty text", async () => {
    assert.deepEqual(await new InMemoryMemoryStore().addTranscript(t("t-empty", "   ")), []);
  });

  it("heuristic scorer boosts pricing/objection content and keeps a 0.2 floor", () => {
    // floor 0.2 + price/cost/budget 0.35 + worry 0.3 = 0.85
    assert.ok(Math.abs(heuristicImportanceScorer("The price is too expensive, I worry about the cost and budget") - 0.85) < 1e-9);
    assert.equal(heuristicImportanceScorer("I had coffee this morning and it was nice"), 0.2);
  });

  it("supports an async (model-style) importance scorer", async () => {
    const chunks = await chunkText("word ".repeat(250).trim(), { importanceScorer: async (c) => (c.includes("word") ? 0.9 : 0.1) });
    assert.equal(chunks.length, 3);
    assert.ok(chunks.every((c) => c.importance === 0.9));
  });
});

describe("retrieval", () => {
  async function seeded(): Promise<InMemoryMemoryStore> {
    const store = new InMemoryMemoryStore();
    await store.addTranscript(
      t("t-pricing", "Interviewer: What stopped you from buying? Interviewee: The pricing page confused me. It said $49 per month but then annual billing was required. The cost felt too high for a small team. I worried about hidden fees and whether the ROI would ever show up."),
    );
    await store.addTranscript(t("t-onboarding", "Interviewer: Tell me about setup. Interviewee: The onboarding flow was smooth and the dashboard looked clean. I liked the color scheme and the empty state illustrations."));
    return store;
  }

  it("returns the relevant node first for a focal query", async () => {
    const store = await seeded();
    const results = await store.retrieve("pricing cost per month ROI", { k: 3 });
    assert.equal(results[0]?.node.transcriptId, "t-pricing");
    assert.ok(results[0]!.relevance > results[1]!.relevance);
    for (let i = 1; i < results.length; i++) assert.ok(results[i - 1]!.score >= results[i]!.score);
  });

  it("respects k and kind filters", async () => {
    const store = await seeded();
    await store.addNode({ id: "refl-1", transcriptId: "t-pricing", kind: "reflection", content: "pricing confusion is the dominant blocker", importance: 1, chunkIndex: 0 });
    assert.equal((await store.retrieve("pricing", { k: 10 })).length, 3);
    const refl = await store.retrieve("pricing", { k: 10, kinds: ["reflection"] });
    assert.deepEqual(refl.map((r) => r.node.id), ["refl-1"]);
    assert.equal((await store.retrieve("pricing", { k: 1 })).length, 1);
  });

  it("refreshes lastRetrieved on retrieval (recency decays from there)", async () => {
    const store = await seeded();
    const now = Date.now();
    for (const r of await store.retrieve("pricing", { k: 10, now })) assert.equal(r.node.lastRetrieved, now);
    const later = await store.retrieve("pricing", { k: 10, now: now + 100 * 3_600_000 });
    // 100 hours at 0.99/hour ≈ 0.366.
    for (const r of later) assert.ok(Math.abs(r.recency - 0.366) < 0.001);
    // Retrieved at T+100h, so at T+100h they are fresh again (recency 1); a
    // node never retrieved since creation would still read ≈0.366.
    const again = await store.retrieve("pricing", { k: 10, now: now + 100 * 3_600_000 });
    for (const r of again) assert.equal(r.recency, 1);
    assert.equal(RECENCY_DECAY, 0.99);
  });

  it("relevance follows the embedder (an injected embedder decides)", async () => {
    const onboardingOnly = async (text: string) => (/onboarding/.test(text) ? [1, 0] : [0, 1]);
    const store = new InMemoryMemoryStore(onboardingOnly);
    await store.addTranscript(t("t-a", "pricing pricing pricing"));
    await store.addTranscript(t("t-b", "the onboarding was smooth"));
    const results = await store.retrieve("onboarding", { k: 5 });
    assert.equal(results[0]?.node.transcriptId, "t-b");
    assert.equal(results[0]?.relevance, 1);
  });

  it("the fake embedder gives 0 similarity for an empty query and >0 for shared words", async () => {
    assert.equal(cosine(await lexicalTestEmbedder(""), await lexicalTestEmbedder("some content here")), 0);
    assert.ok(cosine(await lexicalTestEmbedder("pricing cost"), await lexicalTestEmbedder("the pricing and cost were discussed")) > 0);
  });
});

describe("scoped retrieval (evidence starvation fix)", () => {
  it("perTranscript returns k nodes from EACH transcript even when one transcript dominates", async () => {
    const store = new InMemoryMemoryStore();
    // A long pricing-heavy interview would take the whole global top-k.
    await store.addTranscript(t("loud", "price cost budget pricing objection. ".repeat(300)), { chunkSizeWords: 40, overlapWords: 0 });
    await store.addTranscript(t("quiet", "We mostly worry about setup time and the learning curve for the team."));
    const global = await store.retrieve("price cost budget objection", { k: 4, transcriptIds: ["loud", "quiet"] });
    assert.ok(global.every((s) => s.node.transcriptId === "loud"), "precondition: the global top-k starves 'quiet'");
    const scoped = await store.retrieve("price cost budget objection", { k: 2, perTranscript: true, transcriptIds: ["loud", "quiet"] });
    assert.deepEqual([...new Set(scoped.map((s) => s.node.transcriptId))].sort(), ["loud", "quiet"]);
    // k = 2 per transcript: two "loud" chunks and quiet's only chunk.
    assert.equal(scoped.filter((s) => s.node.transcriptId === "loud").length, 2);
    assert.equal(scoped.length, 3);
  });

  it("a persona's scope never returns another persona's interview or walk nodes", async () => {
    const store = new InMemoryMemoryStore();
    await store.addTranscript(t("mine", "pricing is my concern"));
    await store.addTranscript(t("theirs", "pricing is their concern"));
    await store.addNode({ id: "w1", kind: "thought", runId: "r1", personaKey: "p1", content: "pricing thought of p1", importance: 0.5, chunkIndex: 0 });
    await store.addNode({ id: "w2", kind: "thought", runId: "r1", personaKey: "p2", content: "pricing thought of p2", importance: 0.5, chunkIndex: 0 });
    const ids = (await store.retrieve("pricing", { k: 10, transcriptIds: ["mine"], runId: "r1", personaKey: "p1" })).map((s) => s.node.id).sort();
    assert.deepEqual(ids, ["mine:chunk:0", "w1"]);
  });
});
