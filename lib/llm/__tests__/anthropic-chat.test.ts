// ShapesOS — Phase 7: Anthropic chat() / chatStream() against a stubbed SDK client.
// Run: npx tsx --test lib/llm/__tests__/anthropic-chat.test.ts
//
// Nothing touches the network: the client is a stub, and streams are real
// SDK MessageStreams built from canned event lists (MessageStream.
// fromReadableStream), so the SDK's own accumulation runs. Request shapes
// follow the Claude API docs (bundled claude-api skill) as read 2026-10-04 and
// are UNVERIFIED against the live API from this sandbox.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import {
  AnthropicLlmProvider,
  anthropicModelCaps,
  buildAnthropicParams,
  classifyAnthropicError,
  type AnthropicClientLike,
} from "../anthropic";
import { LlmProviderError } from "../errors";
import { __setChatUsageRecorder, type ChatUsageRecord } from "../usage";
import type { ChatRequest, ChatStreamEvent, ChatToolDef } from "../types";

const WRITE_FILE: ChatToolDef = {
  name: "write_file",
  description: "Write text to a file. Call this when the user asks to save content.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, contents: { type: "string" } },
    required: ["path", "contents"],
    additionalProperties: false,
  },
};
const LOOKUP: ChatToolDef = {
  name: "account_lookup",
  description: "Look up an account by id.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
};

const base = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  system: "You are the lead agent.",
  messages: [{ role: "user", content: "Save a note." }],
  maxTokens: 1024,
  ...extra,
});

type P = Record<string, unknown>;
const params = (model: string, req: ChatRequest, stream = false) =>
  buildAnthropicParams(model, req, { stream }) as unknown as { params: P; notes: string[]; serverToolsSent: string[] };

function message(over: Partial<Anthropic.Messages.Message> = {}): Anthropic.Messages.Message {
  return {
    id: "msg_test_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "Done.", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 50,
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

function stubClient(opts: { create?: (p: P) => unknown; stream?: (p: P) => MessageStream }) {
  const calls: Array<{ kind: "create" | "stream"; params: P; signal?: AbortSignal }> = [];
  const client: AnthropicClientLike = {
    messages: {
      create: async (p, o) => {
        calls.push({ kind: "create", params: p as unknown as P, signal: o?.signal });
        const r = opts.create ? opts.create(p as unknown as P) : message();
        if (r instanceof Error) throw r;
        return r as Anthropic.Messages.Message;
      },
      stream: (p, o) => {
        calls.push({ kind: "stream", params: p as unknown as P, signal: o?.signal });
        return opts.stream!(p as unknown as P);
      },
    },
  };
  return { client, calls };
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("request shape: tools, caching, thinking/effort, server tools", () => {
  it("maps tools (sorted, schema as input_schema) and puts one cache breakpoint on the last system block", () => {
    const { params: p } = params("claude-opus-5-5", base({ tools: [WRITE_FILE, LOOKUP], cache: true }));
    const tools = p.tools as P[];
    assert.deepEqual(tools.map((t) => t.name), ["account_lookup", "write_file"]);
    assert.deepEqual(tools[1].input_schema, WRITE_FILE.inputSchema);
    assert.equal(tools[1].description, WRITE_FILE.description);
    assert.equal("eager_input_streaming" in tools[1], false, "not on non-streaming requests");
    assert.equal(tools.some((t) => "cache_control" in t), false, "system breakpoint covers the tools");
    const system = p.system as P[];
    assert.deepEqual(system, [{ type: "text", text: "You are the lead agent.", cache_control: { type: "ephemeral" } }]);
    assert.equal("cache_control" in p, false, "no automatic caching unless asked");
  });

  it("without a system prompt the breakpoint goes on the last client tool", () => {
    const { params: p } = params("claude-opus-5-5", base({ system: undefined, tools: [WRITE_FILE, LOOKUP], cache: true }));
    const tools = p.tools as P[];
    assert.deepEqual(tools[1].cache_control, { type: "ephemeral" });
    assert.equal("cache_control" in tools[0], false);
    assert.equal("system" in p, false);
  });

  it("cacheConversation adds top-level automatic caching; >4 breakpoints is refused before sending", () => {
    const { params: p } = params("claude-opus-5-5", base({ cache: true, cacheConversation: true }));
    assert.deepEqual(p.cache_control, { type: "ephemeral" });
    const many = base({
      system: [{ text: "a", cache: true }, { text: "b", cache: true }, { text: "c", cache: true }],
      messages: [{ role: "user", content: [{ type: "text", text: "x", cache: true }] }],
      cacheConversation: true,
    });
    assert.throws(() => buildAnthropicParams("claude-opus-5-5", many, { stream: false }), (e: unknown) => e instanceof LlmProviderError && e.kind === "client");
  });

  it("streaming sets eager_input_streaming on client tools only", () => {
    const { params: p } = params("claude-opus-5-5", base({ tools: [WRITE_FILE], serverTools: ["web_search"] }), true);
    const tools = p.tools as P[];
    const client = tools.find((t) => t.name === "write_file")!;
    const server = tools.find((t) => t.name === "web_search")!;
    assert.equal(client.eager_input_streaming, true);
    assert.equal("eager_input_streaming" in server, false);
  });

  it("server tools use the 20260209 versions on models that support them", () => {
    const built = params("claude-sonnet-5-5", base({ serverTools: ["web_search", "web_fetch", "web_search"] }));
    assert.deepEqual(built.params.tools, [
      { type: "web_search_20260209", name: "web_search" },
      { type: "web_fetch_20260209", name: "web_fetch" },
    ]);
    assert.deepEqual(built.serverToolsSent, ["web_search", "web_fetch"]);
    const haiku = params("claude-haiku-4-5", base({ serverTools: ["web_search"] }));
    assert.equal("tools" in haiku.params, false);
    assert.deepEqual(haiku.serverToolsSent, []);
    assert.match(haiku.notes.join(" "), /web_search is not available on claude-haiku-4-5/);
  });

  it("adaptive thinking + output_config.effort on Opus 5.5; effort default from the workload", () => {
    const { params: p } = params("claude-opus-5-5", base({ thinking: "adaptive", effort: "high" }));
    assert.deepEqual(p.thinking, { type: "adaptive" });
    assert.deepEqual(p.output_config, { effort: "high" });
    const d = buildAnthropicParams("claude-opus-5-5", base(), { stream: false, defaultEffort: "medium" }) as unknown as { params: P };
    assert.deepEqual(d.params.output_config, { effort: "medium" });
    const own = buildAnthropicParams("claude-opus-5-5", base({ effort: "low" }), { stream: false, defaultEffort: "medium" }) as unknown as { params: P };
    assert.deepEqual(own.params.output_config, { effort: "low" }, "the request wins over the workload default");
  });

  it("never sends thinking.disabled where it 400s", () => {
    // Opus 5.5 / Fable 5.1: cannot be turned off at all.
    for (const m of ["claude-opus-5-5", "claude-fable-5-1"]) {
      const b = params(m, base({ thinking: "off" }));
      assert.equal("thinking" in b.params, false, m);
      assert.match(b.notes.join(" "), /cannot be turned off/);
    }
    // Sonnet 5.5: between_tools at effort <= high, nothing at max.
    assert.deepEqual(params("claude-sonnet-5-5", base({ thinking: "off" })).params.thinking, { type: "between_tools" });
    assert.deepEqual(params("claude-sonnet-5-5", base({ thinking: "off", effort: "high" })).params.thinking, { type: "between_tools" });
    const max = params("claude-sonnet-5-5", base({ thinking: "off", effort: "max" }));
    assert.equal("thinking" in max.params, false);
    assert.match(max.notes.join(" "), /only at effort high or below/);
    // Opus 5: disabled is fine at high or lower.
    assert.deepEqual(params("claude-opus-5", base({ thinking: "off" })).params.thinking, { type: "disabled" });
  });

  it("Haiku 4.5: no effort, no adaptive thinking — reported, not sent", () => {
    const b = params("claude-haiku-4-5", base({ thinking: "adaptive", effort: "max" }));
    assert.equal("thinking" in b.params, false);
    assert.equal("output_config" in b.params, false);
    assert.equal(b.notes.length, 2);
  });

  it("NEVER sends a forced tool_choice to the 5.5 / Fable 5.1 models", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]) {
      for (const tc of ["any", { name: "write_file" }] as const) {
        const b = params(model, base({ tools: [WRITE_FILE], toolChoice: tc }));
        assert.equal("tool_choice" in b.params, false, `${model} ${JSON.stringify(tc)}`);
        assert.match(b.notes.join(" "), /Forced tool choice is rejected/);
      }
      assert.deepEqual(params(model, base({ tools: [WRITE_FILE], toolChoice: "auto" })).params.tool_choice, { type: "auto" });
      assert.deepEqual(params(model, base({ tools: [WRITE_FILE], toolChoice: "none" })).params.tool_choice, { type: "none" });
    }
    // Models that accept it still get it.
    assert.deepEqual(params("claude-haiku-4-5", base({ tools: [WRITE_FILE], toolChoice: "any" })).params.tool_choice, { type: "any" });
    assert.deepEqual(
      params("claude-opus-5", base({ tools: [WRITE_FILE], toolChoice: { name: "write_file" } })).params.tool_choice,
      { type: "tool", name: "write_file" },
    );
    // Unknown models are treated conservatively.
    assert.equal(anthropicModelCaps("claude-something-new").forcedToolChoice, false);
  });

  it("maps transcript blocks both ways and echoes Anthropic-native blocks verbatim", () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
    const b = params(
      "claude-opus-5-5",
      base({
        tools: [WRITE_FILE],
        messages: [
          { role: "user", content: "Save a note." },
          {
            role: "assistant",
            content: [
              { type: "opaque", provider: "anthropic", kind: "thinking", raw: thinking },
              { type: "tool_use", id: "toolu_1", name: "write_file", input: { path: "a.md", contents: "x" } },
              { type: "opaque", provider: "openai", kind: "reasoning", raw: { id: "rs_1" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: "ok", isError: false }] },
        ],
      }),
    );
    const msgs = b.params.messages as P[];
    assert.deepEqual((msgs[1].content as P[])[0], thinking);
    assert.deepEqual((msgs[1].content as P[])[1], { type: "tool_use", id: "toolu_1", name: "write_file", input: { path: "a.md", contents: "x" } });
    assert.equal((msgs[1].content as P[]).length, 2, "the OpenAI block is dropped");
    assert.deepEqual((msgs[2].content as P[])[0], { type: "tool_result", tool_use_id: "toolu_1", content: "ok" });
    assert.match(b.notes.join(" "), /from another provider/);
  });
});

describe("chat(): response mapping and stop reasons", () => {
  it("maps content, usage (incl. cache) and cost; records usage with the context", async () => {
    const records: ChatUsageRecord[] = [];
    restore = __setChatUsageRecorder(async (r) => void records.push(r));
    const { client, calls } = stubClient({
      create: () =>
        message({
          stop_reason: "tool_use",
          content: [
            { type: "thinking", thinking: "plan", signature: "s1" },
            { type: "text", text: "Saving.", citations: null },
            { type: "tool_use", id: "toolu_9", name: "write_file", input: { path: "n.md", contents: "hi" } },
          ] as unknown as Anthropic.Messages.ContentBlock[],
        }),
    });
    const p = new AnthropicLlmProvider("k", "claude-opus-5-5", { client, workload: "lead", defaultEffort: "medium" });
    const res = await p.chat(base({ tools: [WRITE_FILE], usage: { workspaceId: "ws1", runId: "run1" } }));
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0].params.output_config as P).effort, "medium");
    assert.equal(res.stopReason, "tool_use");
    assert.equal(res.truncated, false);
    assert.equal(res.provider, "anthropic");
    assert.equal(res.model, "claude-opus-5-5");
    assert.deepEqual(res.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 50 });
    // 100×4 + 20×20 + 1000×0.2 + 50×5 = 400 + 400 + 200 + 250
    assert.equal(res.costMicroUsd, 1250);
    assert.equal(res.content[0].type, "opaque");
    assert.equal(res.content[1].type, "text");
    const tu = res.content[2];
    assert.ok(tu.type === "tool_use" && !tu.invalid && tu.input.path === "n.md");
    assert.equal(records.length, 1);
    assert.equal(records[0].context.runId, "run1");
    assert.equal(records[0].workload, "lead");
    assert.equal(records[0].responseId, "msg_test_1");
    assert.equal(records[0].costMicroUsd, 1250);
  });

  it("refusal is surfaced with its details and blocks the turn's tools", async () => {
    const { client } = stubClient({
      create: () =>
        message({
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
          content: [{ type: "tool_use", id: "t", name: "write_file", input: { path: "x" } }],
        } as unknown as Partial<Anthropic.Messages.Message>),
    });
    const res = await new AnthropicLlmProvider("k", "claude-opus-5-5", { client }).chat(base({ tools: [WRITE_FILE] }));
    assert.equal(res.stopReason, "refusal");
    assert.deepEqual(res.stopDetails, { category: "cyber", explanation: "declined" });
    const tu = res.content[0];
    assert.ok(tu.type === "tool_use" && /refusal/.test(tu.invalid ?? ""));
  });

  it("max_tokens is never silent: truncated=true and a cut-off tool call is not runnable", async () => {
    const { client } = stubClient({
      create: () =>
        message({
          stop_reason: "max_tokens",
          content: [{ type: "tool_use", id: "t", name: "write_file", input: { path: "x", contents: "partial" } }] as unknown as Anthropic.Messages.ContentBlock[],
        }),
    });
    const res = await new AnthropicLlmProvider("k", "claude-opus-5-5", { client }).chat(base({ tools: [WRITE_FILE] }));
    assert.equal(res.stopReason, "max_tokens");
    assert.equal(res.truncated, true);
    const tu = res.content[0];
    assert.ok(tu.type === "tool_use" && /output-token cap/.test(tu.invalid ?? ""));
  });

  it("pause_turn and context-window stops map through", async () => {
    for (const [raw, mapped] of [
      ["pause_turn", "pause_turn"],
      ["model_context_window_exceeded", "context_window_exceeded"],
      [null, "other"],
    ] as const) {
      const { client } = stubClient({ create: () => message({ stop_reason: raw as Anthropic.Messages.StopReason }) });
      const res = await new AnthropicLlmProvider("k", "claude-opus-5-5", { client }).chat(base());
      assert.equal(res.stopReason, mapped);
    }
  });

  it("errors keep the Phase 6 classification; an abort surfaces as the abort", async () => {
    const rate = Anthropic.APIError.generate(429, { type: "error", error: { type: "rate_limit_error" } }, "rate", new Headers());
    const { client } = stubClient({ create: () => rate });
    await assert.rejects(new AnthropicLlmProvider("k", "claude-opus-5-5", { client }).chat(base()), (e: unknown) => e instanceof LlmProviderError && e.kind === "rate_limit" && e.retryable);
    const bad = Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error" } }, "bad", new Headers());
    const { client: c2 } = stubClient({ create: () => bad });
    await assert.rejects(new AnthropicLlmProvider("k", "claude-opus-5-5", { client: c2 }).chat(base()), (e: unknown) => e instanceof LlmProviderError && e.kind === "client" && !e.retryable);

    const ac = new AbortController();
    const reason = new Error("run stopped");
    ac.abort(reason);
    const { client: c3, calls } = stubClient({ create: () => new Anthropic.APIUserAbortError() });
    await assert.rejects(new AnthropicLlmProvider("k", "claude-opus-5-5", { client: c3 }).chat(base({ signal: ac.signal })), (e: unknown) => e === reason);
    assert.equal(calls[0].signal, ac.signal, "the caller's signal reaches the SDK");
    assert.equal(classifyAnthropicError(new SyntaxError("Unexpected token")).kind, "tool_input");
  });
});

// ── streaming ───────────────────────────────────────────────────────────────

const msgStart = {
  type: "message_start",
  message: {
    id: "msg_stream_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
  },
};
const textBlock = (index: number, parts: string[]) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...parts.map((t) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index },
];
const toolBlock = (index: number, id: string, name: string, fragments: string[]) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
  ...fragments.map((f) => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: f } })),
  { type: "content_block_stop", index },
];
const msgEnd = (stop: string, output = 30) => [
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: output } },
  { type: "message_stop" },
];

describe("chatStream(): event mapping", () => {
  it("maps text deltas, tool_use start / input deltas / stop, then message_stop and final", async () => {
    const records: ChatUsageRecord[] = [];
    restore = __setChatUsageRecorder(async (r) => void records.push(r));
    const { client, calls } = stubClient({
      stream: () =>
        streamOf([
          msgStart,
          ...textBlock(0, ["Saving ", "now."]),
          ...toolBlock(1, "toolu_s1", "write_file", ['{"path": "a', '.md", "contents"', ': "hello"}']),
          ...msgEnd("tool_use"),
        ]),
    });
    const p = new AnthropicLlmProvider("k", "claude-opus-5-5", { client, workload: "code", defaultEffort: "high" });
    const events = await collect(p.chatStream(base({ tools: [WRITE_FILE], usage: { workspaceId: "ws" } })));
    // The request streamed with eager input streaming.
    assert.equal(calls[0].kind, "stream");
    assert.equal(((calls[0].params.tools as P[])[0]).eager_input_streaming, true);

    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      "text_delta",
      "text_delta",
      "tool_use_start",
      "tool_input_delta",
      "tool_input_delta",
      "tool_input_delta",
      "tool_use_stop",
      "message_stop",
      "final",
    ]);
    const deltas = events.filter((e) => e.type === "tool_input_delta").map((e) => (e as { partialJson: string }).partialJson);
    assert.equal(deltas.join(""), '{"path": "a.md", "contents": "hello"}');
    const stop = events.find((e) => e.type === "tool_use_stop") as Extract<ChatStreamEvent, { type: "tool_use_stop" }>;
    assert.deepEqual(stop.input, { path: "a.md", contents: "hello" });
    assert.equal(stop.invalid, undefined);
    const ms = events.find((e) => e.type === "message_stop") as Extract<ChatStreamEvent, { type: "message_stop" }>;
    assert.equal(ms.stopReason, "tool_use");
    assert.deepEqual(ms.usage, { inputTokens: 40, outputTokens: 30, cacheReadTokens: 500, cacheWriteTokens: 0 });
    const final = (events.at(-1) as Extract<ChatStreamEvent, { type: "final" }>).response;
    assert.equal(final.id, "msg_stream_1");
    assert.equal(final.content.length, 2);
    assert.ok(final.content[1].type === "tool_use" && final.content[1].input.contents === "hello");
    assert.equal(records.length, 1, "usage recorded once, before final");
  });

  it("validates streamed tool input against its schema (eager streaming turns off API validation)", async () => {
    const { client } = stubClient({
      stream: () => streamOf([msgStart, ...toolBlock(0, "toolu_bad", "write_file", ['{"path": 42}']), ...msgEnd("tool_use")]),
    });
    const events = await collect(new AnthropicLlmProvider("k", "claude-opus-5-5", { client }).chatStream(base({ tools: [WRITE_FILE] })));
    const stop = events.find((e) => e.type === "tool_use_stop") as Extract<ChatStreamEvent, { type: "tool_use_stop" }>;
    assert.match(stop.invalid ?? "", /does not match its schema/);
    assert.match(stop.invalid ?? "", /path/);
    const final = (events.at(-1) as Extract<ChatStreamEvent, { type: "final" }>).response;
    assert.ok(final.content[0].type === "tool_use" && final.content[0].invalid);
  });

  it("does not trust the SDK's tolerant parse: an unescaped inner quote is invalid, not silently truncated", async () => {
    // partialParse repairs this into {"path":"a.md","contents":"say "} — strict JSON.parse refuses it.
    const { client } = stubClient({
      stream: () =>
        streamOf([msgStart, ...toolBlock(0, "toolu_q", "write_file", ['{"path": "a.md", "contents": "say "hi""}']), ...msgEnd("tool_use")]),
    });
    const events = await collect(new AnthropicLlmProvider("k", "claude-opus-5-5", { client }).chatStream(base({ tools: [WRITE_FILE] })));
    const stop = events.find((e) => e.type === "tool_use_stop") as Extract<ChatStreamEvent, { type: "tool_use_stop" }>;
    assert.match(stop.invalid ?? "", /not valid JSON/);
    const final = (events.at(-1) as Extract<ChatStreamEvent, { type: "final" }>).response;
    assert.ok(final.content[0].type === "tool_use" && /not valid JSON/.test(final.content[0].invalid ?? ""));
  });

  it("JSON the SDK cannot repair at all is a classified, non-retryable tool_input error (re-issue the turn)", async () => {
    const { client } = stubClient({
      stream: () => streamOf([msgStart, ...toolBlock(0, "toolu_x", "write_file", ['{"path": 1,, "contents": 2}']), ...msgEnd("tool_use")]),
    });
    await assert.rejects(
      collect(new AnthropicLlmProvider("k", "claude-opus-5-5", { client }).chatStream(base({ tools: [WRITE_FILE] }))),
      (e: unknown) => e instanceof LlmProviderError && e.kind === "tool_input" && !e.retryable,
    );
  });

  it("a streamed turn cut off at max_tokens marks its tool call invalid in the final response", async () => {
    const { client } = stubClient({
      stream: () =>
        streamOf([msgStart, ...toolBlock(0, "toolu_m", "write_file", ['{"path": "a.md", "contents": "part"}']), ...msgEnd("max_tokens")]),
    });
    const events = await collect(new AnthropicLlmProvider("k", "claude-opus-5-5", { client }).chatStream(base({ tools: [WRITE_FILE] })));
    const final = (events.at(-1) as Extract<ChatStreamEvent, { type: "final" }>).response;
    assert.equal(final.stopReason, "max_tokens");
    assert.equal(final.truncated, true);
    assert.ok(final.content[0].type === "tool_use" && /output-token cap/.test(final.content[0].invalid ?? ""));
  });

  it("a rate limit before the first event is a classified, retryable error (failover can take it)", async () => {
    const rate = Anthropic.APIError.generate(529, { type: "error", error: { type: "overloaded_error" } }, "overloaded", new Headers());
    const failing = {
      async *[Symbol.asyncIterator]() {
        throw rate;
      },
      finalMessage: async () => {
        throw rate;
      },
    };
    const client: AnthropicClientLike = {
      messages: { create: async () => message(), stream: () => failing as unknown as MessageStream },
    };
    await assert.rejects(collect(new AnthropicLlmProvider("k", "claude-opus-5-5", { client }).chatStream(base())), (e: unknown) => e instanceof LlmProviderError && e.kind === "server" && e.retryable);
  });

  it("breaking out early aborts the SDK stream", async () => {
    let aborted = false;
    const { client } = stubClient({
      stream: () => {
        const s = streamOf([msgStart, ...textBlock(0, ["a", "b", "c"]), ...msgEnd("end_turn")]);
        const orig = s.abort.bind(s);
        s.abort = () => {
          aborted = true;
          orig();
        };
        return s;
      },
    });
    for await (const e of new AnthropicLlmProvider("k", "claude-opus-5-5", { client }).chatStream(base())) {
      if (e.type === "text_delta") break;
    }
    assert.equal(aborted, true);
  });
});
