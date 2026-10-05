// ShapesOS — Phase 7: OpenAI Responses API chat() / chatStream() (offline).
// Run: npx tsx --test lib/llm/__tests__/openai-chat.test.ts
//
// Every request goes to a stub fetch. The Responses API shapes (input items,
// function tools, function_call / function_call_output, SSE event names,
// usage.input_tokens_details.cached_tokens) follow OpenAI's documentation as
// known on 2026-10-04 and are UNVERIFIED against the live API.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatibleLlmProvider, buildResponsesBody, mapResponsesOutput } from "../openai";
import { LlmProviderError } from "../errors";
import { __setChatUsageRecorder, type ChatUsageRecord } from "../usage";
import type { ChatRequest, ChatStreamEvent, ChatToolDef } from "../types";

const KEY = "test-openai-key-ABCDEFGHIJKLMNOPQRSTUVWX";
type P = Record<string, unknown>;

const LOOKUP: ChatToolDef = {
  name: "account_lookup",
  description: "Look up an account by id. Call this when the user names an account.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
};

const base = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  system: [{ text: "You are the lead agent.", cache: true }, { text: "Be brief." }],
  messages: [{ role: "user", content: "Find account 42." }],
  maxTokens: 2048,
  ...extra,
});

function stubFetch(responses: Array<{ status: number; json?: unknown; sse?: unknown[]; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; body: P }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const r = responses[Math.min(calls.length, responses.length - 1)];
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    if (r.sse) {
      const text = r.sse.map((e) => `event: ${(e as P).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
      // Split mid-event to exercise the buffer.
      const enc = new TextEncoder().encode(text);
      const cut = Math.floor(enc.length / 2);
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.slice(0, cut));
          c.enqueue(enc.slice(cut));
          c.close();
        },
      });
      return new Response(body, { status: r.status, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(r.json === undefined ? "" : JSON.stringify(r.json), {
      status: r.status,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const provider = (model: string, f: ReturnType<typeof stubFetch>, extra: P = {}) =>
  new OpenAiCompatibleLlmProvider(KEY, model, "https://api.example.test/v1", {
    fetchImpl: f.impl,
    sleep: async () => undefined,
    ...extra,
  });

const completed = (output: unknown[], usage: P = { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 80 }) => ({
  id: "resp_1",
  object: "response",
  status: "completed",
  model: "gpt-5.5",
  output,
  usage,
});

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("Responses API request mapping (ours → OpenAI)", () => {
  it("system → instructions, tools → function tools, store:false, reasoning effort, max_output_tokens", () => {
    const { body, notes } = buildResponsesBody("gpt-5.5", base({ tools: [LOOKUP], effort: "medium", toolChoice: "auto" }), {
      selfHost: false,
      stream: false,
    });
    assert.equal(body.model, "gpt-5.5");
    assert.equal(body.instructions, "You are the lead agent.\n\nBe brief.");
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 2048);
    assert.deepEqual(body.reasoning, { effort: "medium" });
    assert.deepEqual(body.tools, [
      { type: "function", name: "account_lookup", description: LOOKUP.description, parameters: LOOKUP.inputSchema, strict: false },
    ]);
    assert.equal(body.tool_choice, "auto");
    assert.deepEqual(body.input, [{ role: "user", content: "Find account 42." }]);
    assert.equal("stream" in body, false);
    assert.deepEqual(notes, []);
  });

  it("server tools are not sent — and the notes say so; max effort maps to high", () => {
    const { body, notes } = buildResponsesBody("gpt-5.5", base({ serverTools: ["web_search", "web_fetch"], effort: "max" }), {
      selfHost: false,
      stream: true,
    });
    assert.equal("tools" in body, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.match(notes.join(" "), /Server tools \(web_search, web_fetch\) run on Anthropic only; not sent/);
    assert.match(notes.join(" "), /"max" is sent to OpenAI as reasoning effort "high"/);
  });

  it("forced tool choice maps to required / a named function (OpenAI accepts it)", () => {
    assert.equal(buildResponsesBody("gpt-5.5", base({ tools: [LOOKUP], toolChoice: "any" }), { selfHost: false, stream: false }).body.tool_choice, "required");
    assert.deepEqual(
      buildResponsesBody("gpt-5.5", base({ tools: [LOOKUP], toolChoice: { name: "account_lookup" } }), { selfHost: false, stream: false }).body.tool_choice,
      { type: "function", name: "account_lookup" },
    );
  });

  it("transcript: tool_use → function_call, tool_result → function_call_output, in order; foreign blocks dropped", () => {
    const { body, notes } = buildResponsesBody(
      "gpt-5.5",
      base({
        tools: [LOOKUP],
        messages: [
          { role: "user", content: "Find account 42." },
          {
            role: "assistant",
            content: [
              { type: "opaque", provider: "anthropic", kind: "thinking", raw: { type: "thinking", signature: "s" } },
              { type: "text", text: "Looking it up." },
              { type: "tool_use", id: "toolu_1", name: "account_lookup", input: { id: "42" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "toolu_1", content: [{ type: "text", text: "Acme" }] },
              { type: "text", text: "Thanks — and the owner?" },
            ],
          },
        ],
      }),
      { selfHost: false, stream: false },
    );
    assert.deepEqual(body.input, [
      { role: "user", content: "Find account 42." },
      { role: "assistant", content: "Looking it up." },
      { type: "function_call", call_id: "toolu_1", name: "account_lookup", arguments: '{"id":"42"}' },
      { type: "function_call_output", call_id: "toolu_1", output: "Acme" },
      { role: "user", content: "Thanks — and the owner?" },
    ]);
    assert.match(notes.join(" "), /1 provider-specific block/);
  });

  it(":flex keeps its service tier; self-host sends no reasoning field", () => {
    const flex = buildResponsesBody("gpt-5-nano:flex", base({ effort: "low" }), { selfHost: false, stream: false }).body;
    assert.equal(flex.model, "gpt-5-nano");
    assert.equal(flex.service_tier, "flex");
    const sh = buildResponsesBody("qwen3:27b", base({ effort: "low" }), { selfHost: true, stream: false });
    assert.equal(sh.body.model, "qwen3:27b");
    assert.equal("reasoning" in sh.body, false);
    assert.match(sh.notes.join(" "), /not sent to qwen3:27b/);
  });
});

describe("Responses API response mapping (OpenAI → ours)", () => {
  it("function_call → validated tool_use; cached tokens split out of input; cost from the price table", async () => {
    const records: ChatUsageRecord[] = [];
    restore = __setChatUsageRecorder(async (r) => void records.push(r));
    const f = stubFetch([
      {
        status: 200,
        json: completed([
          { type: "reasoning", id: "rs_1", summary: [] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking.", annotations: [] }] },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "account_lookup", arguments: '{"id":"42"}' },
        ]),
      },
    ]);
    const res = await provider("gpt-5.5", f, { workload: "lead", defaultEffort: "medium" }).chat(
      base({ tools: [LOOKUP], usage: { workspaceId: "ws", runId: "r1" } }),
    );
    assert.equal(f.calls[0].url, "https://api.example.test/v1/responses");
    assert.deepEqual(f.calls[0].body.reasoning, { effort: "medium" }, "workload default effort applied");
    assert.equal(res.provider, "openai-compatible");
    assert.equal(res.id, "resp_1");
    assert.equal(res.stopReason, "tool_use");
    assert.deepEqual(res.content[0], { type: "text", text: "Checking." });
    assert.deepEqual(res.content[1], { type: "tool_use", id: "call_1", name: "account_lookup", input: { id: "42" } });
    assert.deepEqual(res.usage, { inputTokens: 200, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: 0 });
    // 200×5 + 80×30 + 1000×0.5 = 1000 + 2400 + 500
    assert.equal(res.costMicroUsd, 3900);
    assert.deepEqual(res.meta.serverToolsSent, []);
    assert.equal(records.length, 1);
    assert.equal(records[0].provider, "openai-compatible");
    assert.equal(records[0].responseId, "resp_1");
  });

  it("arguments that fail the schema or are not JSON come back invalid, never runnable", () => {
    const req = base({ tools: [LOOKUP] });
    const res = mapResponsesOutput(
      completed([
        { type: "function_call", call_id: "c1", name: "account_lookup", arguments: '{"id": 42}' },
        { type: "function_call", call_id: "c2", name: "account_lookup", arguments: '{"id": "4' },
        { type: "function_call", call_id: "c3", name: "not_a_tool", arguments: "{}" },
      ]) as never,
      { model: "gpt-5.5", provider: "openai-compatible", req, notes: [] },
    );
    const [a, b, c] = res.content;
    assert.ok(a.type === "tool_use" && /does not match its schema/.test(a.invalid ?? ""));
    assert.ok(b.type === "tool_use" && /not valid JSON/.test(b.invalid ?? ""));
    assert.ok(c.type === "tool_use" && /unknown tool/.test(c.invalid ?? ""));
  });

  it("incomplete (max_output_tokens) → max_tokens + truncated; content_filter / refusal → refusal", () => {
    const req = base({ tools: [LOOKUP] });
    const cut = mapResponsesOutput(
      {
        ...completed([{ type: "function_call", call_id: "c", name: "account_lookup", arguments: '{"id":"4"}' }]),
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      } as never,
      { model: "gpt-5.5", provider: "p", req, notes: [] },
    );
    assert.equal(cut.stopReason, "max_tokens");
    assert.equal(cut.truncated, true);
    assert.ok(cut.content[0].type === "tool_use" && /output-token cap/.test(cut.content[0].invalid ?? ""));
    const filtered = mapResponsesOutput({ ...completed([]), status: "incomplete", incomplete_details: { reason: "content_filter" } } as never, {
      model: "gpt-5.5",
      provider: "p",
      req,
      notes: [],
    });
    assert.equal(filtered.stopReason, "refusal");
    const refused = mapResponsesOutput(
      completed([{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }]) as never,
      { model: "gpt-5.5", provider: "p", req, notes: [] },
    );
    assert.equal(refused.stopReason, "refusal");
    assert.equal(refused.stopDetails?.explanation, "I can't help with that.");
  });

  it("errors keep the Phase 6 classification (429 retried once, 400 not)", async () => {
    const f = stubFetch([{ status: 429, json: { error: { code: "rate_limit_exceeded" } }, headers: { "retry-after": "1" } }, { status: 200, json: completed([]) }]);
    const res = await provider("gpt-5.5", f).chat(base());
    assert.equal(f.calls.length, 2);
    assert.equal(res.stopReason, "end_turn");
    const bad = stubFetch([{ status: 400, json: { error: { code: "invalid_value" } } }]);
    await assert.rejects(provider("gpt-5.5", bad).chat(base()), (e: unknown) => e instanceof LlmProviderError && e.kind === "client" && /invalid_value/.test(e.message));
    assert.equal(bad.calls.length, 1);
    const failed = stubFetch([{ status: 200, json: { id: "r", status: "failed", error: { code: "server_error" } } }]);
    await assert.rejects(provider("gpt-5.5", failed, { maxRetries: 0 }).chat(base()), (e: unknown) => e instanceof LlmProviderError && e.kind === "server");
  });
});

describe("Responses API streaming", () => {
  it("maps SSE events to text / tool_use start / input delta / stop, then message_stop and final", async () => {
    const records: ChatUsageRecord[] = [];
    restore = __setChatUsageRecorder(async (r) => void records.push(r));
    const final = completed([
      { type: "message", content: [{ type: "output_text", text: "On it." }] },
      { type: "function_call", call_id: "call_s", name: "account_lookup", arguments: '{"id":"42"}' },
    ]);
    const f = stubFetch([
      {
        status: 200,
        sse: [
          { type: "response.created", response: { id: "resp_1" } },
          { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
          { type: "response.output_text.delta", output_index: 0, delta: "On " },
          { type: "response.output_text.delta", output_index: 0, delta: "it." },
          { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_s", name: "account_lookup", arguments: "" } },
          { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"id":' },
          { type: "response.function_call_arguments.delta", output_index: 1, delta: '"42"}' },
          { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "call_s", name: "account_lookup", arguments: '{"id":"42"}' } },
          { type: "response.completed", response: final },
        ],
      },
    ]);
    const events: ChatStreamEvent[] = [];
    for await (const e of provider("gpt-5.5", f).chatStream(base({ tools: [LOOKUP], usage: { workspaceId: "ws" } }))) events.push(e);
    assert.equal(f.calls[0].body.stream, true);
    assert.deepEqual(
      events.map((e) => e.type),
      ["text_delta", "text_delta", "tool_use_start", "tool_input_delta", "tool_input_delta", "tool_use_stop", "message_stop", "final"],
    );
    const stop = events[5] as Extract<ChatStreamEvent, { type: "tool_use_stop" }>;
    assert.deepEqual(stop.input, { id: "42" });
    assert.equal(stop.id, "call_s");
    const res = (events[7] as Extract<ChatStreamEvent, { type: "final" }>).response;
    assert.equal(res.stopReason, "tool_use");
    assert.equal(records.length, 1);
  });

  it("a stream that ends without a terminal event is a server error; response.failed too", async () => {
    const f = stubFetch([{ status: 200, sse: [{ type: "response.output_text.delta", output_index: 0, delta: "x" }] }]);
    await assert.rejects(
      (async () => {
        for await (const _ of provider("gpt-5.5", f).chatStream(base())) void _;
      })(),
      (e: unknown) => e instanceof LlmProviderError && e.kind === "server" && /without a completed response/.test(e.message),
    );
    const g = stubFetch([{ status: 200, sse: [{ type: "response.failed", response: { error: { code: "server_error" } } }] }]);
    await assert.rejects(
      (async () => {
        for await (const _ of provider("gpt-5.5", g).chatStream(base())) void _;
      })(),
      (e: unknown) => e instanceof LlmProviderError && /server_error/.test(e.message),
    );
  });
});
