// ShapesOS — Phase 17 (WS=model): the Anthropic adapter's cache layout,
// tool search / defer_loading, context editing, service tier and per-call
// timing — against a stubbed SDK client (no network; MOCK).
//
// Every option name below was read from the installed SDK (0.128.0):
//   CacheControlEphemeral.ttl '5m' | '1h'      resources/messages/messages.d.ts
//   Tool.defer_loading, ToolSearchToolBm25_20251119   (same file)
//   MessageCreateParams.service_tier 'auto' | 'standard_only'   (same file)
//   Usage.cache_creation.ephemeral_1h_input_tokens, Usage.service_tier   (same file)
//   BetaClearToolUses20250919Edit { trigger, keep, clear_at_least, exclude_tools }
//                                              resources/beta/messages/messages.d.ts
//   AnthropicBeta 'context-management-2025-06-27'   resources/beta/beta.d.ts
// Run: env -u DATABASE_URL npx tsx --test lib/llm/__tests__/anthropic-p17.test.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import {
  AnthropicLlmProvider,
  anthropicModelCaps,
  buildAnthropicParams,
  CLEAR_TOOL_USES_EDIT,
  COMPACTION_BETA,
  COMPACTION_EDIT,
  CONTEXT_EDITING_BETA,
  TOOL_SEARCH_TOOL,
  type AnthropicClientLike,
} from "../anthropic";
import { FailoverLlmProvider } from "../failover";
import { OpenAiCompatibleLlmProvider } from "../openai";
import { __setChatUsageRecorder, cacheHit, type ChatUsageRecord } from "../usage";
import type { ChatRequest, ChatStreamEvent, ChatToolDef } from "../types";

type P = Record<string, unknown>;

const tool = (name: string, deferLoading = false): ChatToolDef => ({
  name,
  description: `${name} does a thing.`,
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  ...(deferLoading ? { deferLoading: true } : {}),
});

const base = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  system: [{ text: "STATIC PREFIX", cache: true }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 512,
  ...extra,
});

const build = (model: string, req: ChatRequest, opts: { stream?: boolean; betaAvailable?: boolean } = {}) =>
  buildAnthropicParams(model, req, { stream: opts.stream ?? false, betaAvailable: opts.betaAvailable ?? true });

function message(over: Partial<Anthropic.Messages.Message> = {}): Anthropic.Messages.Message {
  return {
    id: "msg_p17",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "ok", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 },
      service_tier: "standard",
    },
    ...over,
  } as unknown as Anthropic.Messages.Message;
}

function streamOf(events: unknown[]): MessageStream {
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const rs = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(body));
      c.close();
    },
  });
  return MessageStream.fromReadableStream(rs);
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("A1 — cache layout", () => {
  it("cache: true puts a breakpoint on the last LOADED tool and on the last system block, with the request's TTL", () => {
    const b = build("claude-opus-5-5", base({ tools: [tool("b_tool"), tool("a_tool")], cache: true, cacheTtl: "1h", cacheConversation: true }));
    const p = b.params as unknown as P;
    const tools = p.tools as P[];
    assert.deepEqual(tools.map((t) => t.name), ["a_tool", "b_tool"], "sorted by name (byte-stable)");
    assert.equal("cache_control" in tools[0], false);
    assert.deepEqual(tools[1].cache_control, { type: "ephemeral", ttl: "1h" });
    assert.deepEqual((p.system as P[])[0].cache_control, { type: "ephemeral", ttl: "1h" });
    // The conversation tail stays on the default 5m TTL (a 1h marker before
    // a 5m automatic tail is the documented order).
    assert.deepEqual(p.cache_control, { type: "ephemeral" });
  });

  it("the default TTL is 5 minutes (no ttl field, exactly the pre-Phase-17 shape)", () => {
    const b = build("claude-sonnet-5-5", base({ tools: [tool("x")], cache: true }));
    const tools = (b.params as unknown as P).tools as P[];
    assert.deepEqual(tools[0].cache_control, { type: "ephemeral" });
  });

  it("tool + system + tail = 3 breakpoints; a fourth explicit one still fits, a fifth is refused", () => {
    const ok = base({
      tools: [tool("x")],
      cache: true,
      cacheConversation: true,
      messages: [{ role: "user", content: [{ type: "text", text: "ctx", cache: true }] }],
    });
    build("claude-opus-5-5", ok);
    const tooMany = { ...ok, system: [{ text: "a", cache: true }, { text: "b", cache: true }] };
    assert.throws(() => build("claude-opus-5-5", tooMany), /cache breakpoints/);
  });

  it("maps the 1-hour share of cache writes, the service tier, the effort and the timing onto the response and the usage record", async () => {
    const records: ChatUsageRecord[] = [];
    restore = __setChatUsageRecorder(async (r) => void records.push(r));
    const client: AnthropicClientLike = { messages: { create: async () => message(), stream: () => streamOf([]) } };
    const p = new AnthropicLlmProvider("k", "claude-opus-5-5", { client, workload: "lead", defaultEffort: "medium" });
    const res = await p.chat(base({ usage: { workspaceId: "ws" } }));
    assert.equal(res.usage.cacheWriteTokens, 300);
    assert.equal(res.usage.cacheWrite1hTokens, 200);
    assert.equal(res.serviceTier, "standard");
    assert.equal(res.effort, "medium");
    assert.equal(res.timing?.ttftMs, null, "non-streaming: no first-token time");
    assert.ok(typeof res.timing?.durationMs === "number" && res.timing.durationMs >= 0);
    // Opus 5.5: 10×4 + 5×20 + 2000×0.2 + 100×5 (5m write) + 200×8 (1h write = 2× input) = 40+100+400+500+1600
    assert.equal(res.costMicroUsd, 2640);
    assert.equal(records.length, 1);
    assert.equal(records[0].effort, "medium");
    assert.equal(records[0].serviceTier, "standard");
    assert.equal(records[0].timing?.ttftMs, null);
    assert.equal(cacheHit(records[0].usage), true);
  });

  it("streaming measures time to the first content delta", async () => {
    const client: AnthropicClientLike = {
      messages: {
        create: async () => message(),
        stream: () =>
          streamOf([
            {
              type: "message_start",
              message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hey" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
            { type: "message_stop" },
          ]),
      },
    };
    const events: ChatStreamEvent[] = [];
    for await (const e of new AnthropicLlmProvider("k", "claude-opus-5-5", { client }).chatStream(base())) events.push(e);
    const final = (events.at(-1) as Extract<ChatStreamEvent, { type: "final" }>).response;
    assert.ok(typeof final.timing?.ttftMs === "number" && final.timing.ttftMs >= 0);
    assert.ok(final.timing!.durationMs >= final.timing!.ttftMs!);
  });
});

describe("A2 — tool search and defer_loading", () => {
  it("deferred tools get defer_loading and sort after loaded ones; the BM25 search tool leads; the breakpoint stays on the last loaded tool", () => {
    const b = build("claude-opus-5-5", base({ tools: [tool("z_deferred", true), tool("a_deferred", true), tool("m_loaded")], cache: true, toolSearch: true }));
    const tools = (b.params as unknown as P).tools as P[];
    assert.deepEqual(tools.map((t) => t.name), ["tool_search_tool_bm25", "m_loaded", "a_deferred", "z_deferred"]);
    assert.deepEqual(tools[0], { ...TOOL_SEARCH_TOOL });
    assert.equal("defer_loading" in tools[0], false, "the search tool is never deferred");
    assert.equal("defer_loading" in tools[1], false);
    assert.deepEqual(tools[1].cache_control, { type: "ephemeral" }, "the breakpoint is on the last loaded tool");
    assert.equal(tools[2].defer_loading, true);
    assert.equal(tools[3].defer_loading, true);
    assert.equal("cache_control" in tools[2], false, "a deferred tool may not carry cache_control (400)");
    assert.equal(b.toolSearch, true);
  });

  it("never sends an all-deferred set: the first deferred tool is loaded and a note says so", () => {
    const b = build("claude-opus-5-5", base({ tools: [tool("b", true), tool("a", true)], toolSearch: true }));
    const tools = (b.params as unknown as P).tools as P[];
    assert.deepEqual(tools.map((t) => [t.name, t.defer_loading === true]), [["tool_search_tool_bm25", false], ["a", false], ["b", true]]);
    assert.match(b.notes.join(" "), /Every tool was deferred/);
  });

  it("without toolSearch, deferLoading is ignored (plain loaded tools, no search tool)", () => {
    const b = build("claude-opus-5-5", base({ tools: [tool("a", true)] }));
    const tools = (b.params as unknown as P).tools as P[];
    assert.deepEqual(tools.map((t) => t.name), ["a"]);
    assert.equal("defer_loading" in tools[0], false);
    assert.equal(b.toolSearch, false);
  });

  it("a model without tool search gets the tools loaded, plus a note; the provider reports the capability", () => {
    const b = build("claude-unknown-model", base({ tools: [tool("a", true), tool("b")], toolSearch: true }));
    const tools = (b.params as unknown as P).tools as P[];
    assert.deepEqual(tools.map((t) => t.name), ["a", "b"]);
    assert.equal(tools.some((t) => "defer_loading" in t), false);
    assert.match(b.notes.join(" "), /Tool search is not available/);
    for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]) {
      assert.equal(anthropicModelCaps(m).toolSearch, true, m);
    }
    const client: AnthropicClientLike = { messages: { create: async () => message(), stream: () => streamOf([]) } };
    assert.equal(new AnthropicLlmProvider("k", "claude-opus-5-5", { client }).supportsToolSearch(), true);
    const openai = new OpenAiCompatibleLlmProvider("k", "gpt-5.5", "http://127.0.0.1:1/v1");
    assert.equal(openai.supportsToolSearch(), false);
    // Failover: both sides must run it, or the loop's client-side search is used.
    const fo = new FailoverLlmProvider(new AnthropicLlmProvider("k", "claude-opus-5-5", { client }), openai, { workload: "lead", primaryModel: "a", fallbackModel: "b" });
    assert.equal(fo.supportsToolSearch(), false);
  });
});

describe("A3 — server-side context editing", () => {
  it("sends clear_tool_uses_20250919 with the exact SDK field names under the context-management beta, together with compaction", () => {
    const b = build("claude-opus-5-5", base({
      compaction: true,
      contextEditing: { triggerInputTokens: 100_000, keepToolUses: 8, clearAtLeastTokens: 10_000, excludeTools: ["fetch_more"] },
    }));
    const p = b.params as unknown as P;
    assert.deepEqual(p.betas, [CONTEXT_EDITING_BETA, COMPACTION_BETA]);
    assert.deepEqual(p.context_management, {
      edits: [
        {
          type: CLEAR_TOOL_USES_EDIT,
          trigger: { type: "input_tokens", value: 100_000 },
          keep: { type: "tool_uses", value: 8 },
          clear_at_least: { type: "input_tokens", value: 10_000 },
          exclude_tools: ["fetch_more"],
        },
        { type: COMPACTION_EDIT },
      ],
    });
    assert.equal(b.beta, true);
    assert.equal(b.contextEditing, true);
    assert.equal(b.compaction, true);
  });

  it("context editing alone (a model without compaction) still goes to the beta endpoint, and applied_edits come back as meta", async () => {
    const b = build("claude-sonnet-5-5", base({ compaction: true, contextEditing: { triggerInputTokens: 50_000, keepToolUses: 3 } }));
    const p = b.params as unknown as P;
    assert.deepEqual(p.betas, [CONTEXT_EDITING_BETA]);
    assert.equal(b.compaction, false);
    assert.equal(b.beta, true);
    const calls: string[] = [];
    const client: AnthropicClientLike = {
      messages: { create: async () => (calls.push("plain"), message()), stream: () => streamOf([]) },
      beta: {
        messages: {
          create: async () => {
            calls.push("beta");
            const m = message() as unknown as P;
            m.context_management = { applied_edits: [{ type: CLEAR_TOOL_USES_EDIT, cleared_tool_uses: 4, cleared_input_tokens: 12_000 }] };
            return m as unknown as Anthropic.Messages.Message;
          },
          stream: () => streamOf([]),
        },
      },
    };
    const res = await new AnthropicLlmProvider("k", "claude-sonnet-5-5", { client }).chat(base({ contextEditing: {} }));
    assert.deepEqual(calls, ["beta"]);
    assert.deepEqual(res.meta.contextEdits, [{ type: CLEAR_TOOL_USES_EDIT, clearedInputTokens: 12_000, clearedToolUses: 4 }]);
  });

  it("defaults (trigger 100k, keep 3) match the docs; an unknown model gets a note and nothing sent", () => {
    const b = build("claude-opus-5-5", base({ contextEditing: {} }));
    const edit = ((b.params as unknown as P).context_management as { edits: P[] }).edits[0];
    assert.deepEqual(edit, { type: CLEAR_TOOL_USES_EDIT, trigger: { type: "input_tokens", value: 100_000 }, keep: { type: "tool_uses", value: 3 } });
    const none = build("claude-unknown", base({ contextEditing: {} }));
    assert.equal("context_management" in (none.params as unknown as P), false);
    assert.match(none.notes.join(" "), /context editing is not available/);
  });
});

describe("A4 — service tier", () => {
  it("service_tier is sent as given ('auto' | 'standard_only') and omitted otherwise", () => {
    assert.equal((build("claude-opus-5-5", base({ serviceTier: "standard_only" })).params as unknown as P).service_tier, "standard_only");
    assert.equal((build("claude-opus-5-5", base({ serviceTier: "auto" })).params as unknown as P).service_tier, "auto");
    assert.equal("service_tier" in (build("claude-opus-5-5", base()).params as unknown as P), false);
  });

  it("generate() never takes priority capacity and records its timing", async () => {
    const records: ChatUsageRecord[] = [];
    restore = __setChatUsageRecorder(async (r) => void records.push(r));
    const sent: P[] = [];
    const client: AnthropicClientLike = {
      messages: { create: async (p) => (sent.push(p as unknown as P), message()), stream: () => streamOf([]) },
    };
    await new AnthropicLlmProvider("k", "claude-haiku-4-5", { client, workload: "background" }).generate("x", { usage: { workspaceId: "ws" } });
    assert.equal(sent[0].service_tier, "standard_only");
    assert.equal(records.length, 1);
    assert.ok(typeof records[0].timing?.durationMs === "number");
    assert.equal(records[0].serviceTier, "standard");
  });
});
