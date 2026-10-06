// ShapesOS — Phase 17 (latency, A8): the no-model fast paths that need no
// database — the read-tool cache through the real tool gate (executeTool),
// the answer cache, and the slash-command classifier.
// Run: env -u DATABASE_URL npx tsx --test lib/chat/__tests__/fast-paths.test.ts

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerExtraTool, type ToolContext, type ToolDef } from "../tools";
import { executeTool, type ChatToolCall } from "../tool-exec";
import { CACHEABLE_TOOLS, ToolResultCache, stableJson, toolCacheKey, toolResultCache } from "../tool-cache";
import { AnswerCache, answerCacheKey, cachedAnswerCall, normalizeQuestion, withoutEpisodes, CACHED_ANSWER_TOOL } from "../answer-cache";
import { isSlashCommand, SLASH_COMMANDS } from "../agent";

let reads = 0;
let writes = 0;
// A pure read, registered as cacheable for the test; the real list is CACHEABLE_TOOLS.
const t_read: ToolDef = {
  name: "get_keywords_test_read",
  description: "Read something (pure).",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: { limit: { type: "string", description: "n" } } },
  async execute(_ctx, args) {
    reads++;
    return { summary: `read ${String(args.limit ?? "all")} (#${reads})`, details: { n: reads } };
  },
};
const t_write: ToolDef = {
  name: "t_cache_write",
  description: "Write something (auto-approved in the test through confirmed).",
  kind: "publish",
  minRole: "viewer",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    writes++;
    return { summary: "wrote" };
  },
};

before(() => {
  registerExtraTool(t_read);
  registerExtraTool(t_write);
  (CACHEABLE_TOOLS as Set<string>).add(t_read.name);
});
beforeEach(() => {
  toolResultCache.clear();
  reads = 0;
  writes = 0;
});

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ projectId: "p1", workspaceId: "ws-cache", userId: "u", role: "editor", confirmed: false, agentKey: "lead", grant: null, ...over });
const call = (tool: string, args: Record<string, unknown> = {}): ChatToolCall => ({ tool, args, status: "executed" });

describe("read-tool cache through the tool gate", () => {
  it("the same read with the same arguments runs once within the TTL; different arguments run again", async () => {
    const a = call(t_read.name, { limit: "5" });
    await executeTool(ctx(), t_read.name, a.args, a);
    const b = call(t_read.name, { limit: "5" });
    await executeTool(ctx(), t_read.name, b.args, b);
    assert.equal(reads, 1, "second identical read served from the cache");
    assert.equal(b.resultSummary, a.resultSummary);
    const c = call(t_read.name, { limit: "6" });
    await executeTool(ctx(), t_read.name, c.args, c);
    assert.equal(reads, 2, "different arguments: a real read");
    assert.equal(toolResultCache.hits, 1);
  });

  it("another workspace or project never shares an entry", async () => {
    await executeTool(ctx(), t_read.name, {}, call(t_read.name));
    await executeTool(ctx({ workspaceId: "ws-other" }), t_read.name, {}, call(t_read.name));
    await executeTool(ctx({ projectId: "p2" }), t_read.name, {}, call(t_read.name));
    assert.equal(reads, 3);
  });

  it("a write through the gate drops the workspace's cached reads (a read after the agent's own write is fresh)", async () => {
    await executeTool(ctx(), t_read.name, {}, call(t_read.name));
    await executeTool(ctx({ workspaceId: "ws-other" }), t_read.name, {}, call(t_read.name));
    const w = call(t_write.name);
    await executeTool(ctx({ confirmed: true }), t_write.name, {}, w);
    assert.equal(w.status, "executed");
    assert.equal(writes, 1);
    await executeTool(ctx(), t_read.name, {}, call(t_read.name));
    assert.equal(reads, 3, "ws-cache was invalidated by the write");
    await executeTool(ctx({ workspaceId: "ws-other" }), t_read.name, {}, call(t_read.name));
    assert.equal(reads, 3, "ws-other kept its entry");
  });

  it("a pending (unconfirmed) write runs nothing and drops nothing", async () => {
    await executeTool(ctx(), t_read.name, {}, call(t_read.name));
    const w = call(t_write.name);
    await executeTool(ctx(), t_write.name, {}, w);
    assert.equal(w.status, "pending_confirmation");
    await executeTool(ctx(), t_read.name, {}, call(t_read.name));
    assert.equal(reads, 1);
  });

  it("entries expire after the TTL and the map is bounded", () => {
    let t = 0;
    const c = new ToolResultCache(1_000, 2, () => t);
    c.set("a", { summary: "a" });
    c.set("b", { summary: "b" });
    c.set("c", { summary: "c" });
    assert.equal(c.size, 2, "bounded: the oldest was dropped");
    assert.equal(c.get("a"), null);
    assert.equal(c.get("c")?.summary, "c");
    t = 1_000;
    assert.equal(c.get("c"), null, "expired");
    assert.equal(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
    assert.equal(toolCacheKey({ workspaceId: "w", projectId: "p", tool: "t", args: { b: 1, a: 2 } }), toolCacheKey({ workspaceId: "w", projectId: "p", tool: "t", args: { a: 2, b: 1 } }));
  });

  it("only pure reads are cacheable: load_skill and the sandbox / browser reads are not", () => {
    for (const t of ["load_skill", "read_file", "glob", "grep", "git_clone", "git_status", "git_diff", "browser_open", "browser_extract"]) {
      assert.ok(!CACHEABLE_TOOLS.has(t), `${t} must never be cached`);
    }
    for (const t of ["get_keywords", "get_rankings", "get_alerts", "get_competitors"]) assert.ok(CACHEABLE_TOOLS.has(t));
  });
});

describe("answer cache", () => {
  it("keys on the whole model input: the same question with the same prompt hits; a data change or a different history misses", () => {
    const base = { workspaceId: "w", projectId: "p", system: "PROJECT CONTEXT: 12 keywords", messages: [{ role: "user" as const, content: "What's my visibility score?" }] };
    const k1 = answerCacheKey(base)!;
    assert.equal(answerCacheKey({ ...base, messages: [{ role: "user", content: "  what's my visibility SCORE " }] }), k1, "normalised question");
    assert.notEqual(answerCacheKey({ ...base, system: "PROJECT CONTEXT: 13 keywords" }), k1, "the data version lives in the prompt");
    assert.equal(answerCacheKey({ ...base, messages: [{ role: "user", content: "earlier" }, { role: "assistant", content: "x" }, ...base.messages] }), null, "a question inside a conversation is never cached");
    assert.notEqual(answerCacheKey({ ...base, workspaceId: "w2" }), k1);
    assert.equal(answerCacheKey({ ...base, messages: [] }), null);
    assert.equal(normalizeQuestion("Hello?!"), "hello");
    const withEp = `${base.system}\n\n## EPISODIC CONTEXT — relevant past interactions\npreamble\n<recalled-memory>\n- agent_call: earlier Q\n</recalled-memory>\n\nRULES: x`;
    assert.equal(withoutEpisodes(withEp), `${base.system}\n\n\n\nRULES: x`);
    assert.equal(answerCacheKey({ ...base, system: withEp }), answerCacheKey({ ...base, system: withEp.replace("earlier Q", "another Q") }), "recalled episodes are not part of the data version");
  });

  it("hit / miss / TTL / LRU / workspace invalidation; a cached answer is labelled", () => {
    let t = 0;
    const c = new AnswerCache(1_000, 2, () => t);
    c.set("w:p:1", { text: "one" });
    c.set("w:p:2", { text: "two" });
    assert.equal(c.get("w:p:1")?.text, "one");
    c.set("w:p:3", { text: "three" });
    assert.equal(c.get("w:p:2"), null, "LRU: 2 was the least recently used");
    assert.equal(c.get("w:p:1")?.text, "one");
    t = 1_000;
    assert.equal(c.get("w:p:1"), null, "expired");
    c.set("w:p:4", { text: "four" });
    c.set("v:p:5", { text: "five" });
    c.invalidateWorkspace("w");
    assert.equal(c.get("w:p:4"), null);
    assert.equal(c.get("v:p:5")?.text, "five");
    c.set("w:p:6", { text: "   " });
    assert.equal(c.get("w:p:6"), null, "an empty answer is never stored");
    const marker = cachedAnswerCall("Why?");
    assert.equal(marker.tool, CACHED_ANSWER_TOOL);
    assert.equal(marker.status, "executed");
  });
});

describe("slash commands", () => {
  it("recognises the router's commands only", () => {
    for (const c of SLASH_COMMANDS) assert.ok(isSlashCommand(`${c} something`), c);
    assert.ok(isSlashCommand("  /Keywords"));
    assert.ok(!isSlashCommand("/unknown thing"));
    assert.ok(!isSlashCommand("what about /keywords"));
    assert.ok(!isSlashCommand("yes"));
  });
});
