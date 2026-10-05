// ShapesOS — Phase 7: chat() / chatStream() failover and the scriptable mock.
// Run: npx tsx --test lib/llm/__tests__/chat-failover.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FailoverLlmProvider, lastFailover, __resetFailoverLog } from "../failover";
import { LlmProviderError } from "../errors";
import { MockLlmProvider, MOCK_CHAT_TEXT } from "../mock";
import type { ChatRequest, ChatStreamEvent, ChatToolDef, LlmProvider } from "../types";

const TOOL: ChatToolDef = {
  name: "lookup",
  description: "Look something up.",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
};
const req = (extra: Partial<ChatRequest> = {}): ChatRequest => ({ messages: [{ role: "user", content: "hi" }], maxTokens: 256, ...extra });

const err = (kind: "rate_limit" | "server" | "timeout" | "network" | "client" | "tool_input", status: number | null = null) =>
  new LlmProviderError({ provider: "primary", kind, status, detail: kind });

/** A live-looking provider whose chat behaviour is scripted through the mock. */
function live(name: string, script: ConstructorParameters<typeof MockLlmProvider>[0]): LlmProvider & { mock: MockLlmProvider } {
  const mock = new MockLlmProvider(script);
  return {
    name,
    isLive: true,
    mock,
    isConfigured: () => true,
    generate: (p, o) => mock.generate(p, o),
    chat: (r) => mock.chat(r),
    chatStream: (r) => mock.chatStream(r),
  };
}

function wrap(primary: LlmProvider, fallback: LlmProvider) {
  const logs: string[] = [];
  const p = new FailoverLlmProvider(primary, fallback, {
    workload: "lead",
    primaryModel: "claude-opus-5-5",
    fallbackModel: "gpt-5.5",
    log: (m) => logs.push(m),
  });
  return { p, logs };
}

async function collect(it: AsyncIterable<ChatStreamEvent>) {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

beforeEach(() => __resetFailoverLog());

describe("MockLlmProvider.chat(): deterministic and scriptable", () => {
  it("unscripted: one labelled mock text block, zero usage, never live", async () => {
    const m = new MockLlmProvider();
    const a = await m.chat(req());
    const b = await m.chat(req());
    assert.deepEqual(a, b);
    assert.deepEqual(a.content, [{ type: "text", text: MOCK_CHAT_TEXT }]);
    assert.equal(a.provider, "mock");
    assert.equal(a.stopReason, "end_turn");
    assert.deepEqual(a.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    assert.equal(m.isLive, false);
    assert.equal(m.chatCalls.length, 2);
  });

  it("scripted steps are consumed in order (last repeats); tool calls are checked like live ones", async () => {
    const m = new MockLlmProvider({
      chatScript: [
        { content: [{ type: "tool_use", id: "t1", name: "lookup", input: { q: "x" } }] },
        { content: [{ type: "tool_use", id: "t2", name: "lookup", input: { q: 1 } }] },
        (r, call) => ({ content: [{ type: "text", text: `call ${call}, ${r.messages.length} messages` }] }),
      ],
    });
    const r1 = await m.chat(req({ tools: [TOOL] }));
    assert.equal(r1.stopReason, "tool_use");
    assert.ok(r1.content[0].type === "tool_use" && !r1.content[0].invalid);
    const r2 = await m.chat(req({ tools: [TOOL] }));
    assert.ok(r2.content[0].type === "tool_use" && /schema/.test(r2.content[0].invalid ?? ""));
    assert.deepEqual((await m.chat(req())).content, [{ type: "text", text: "call 2, 1 messages" }]);
    assert.deepEqual((await m.chat(req())).content, [{ type: "text", text: "call 3, 1 messages" }]);
  });

  it("chatStream yields deterministic word chunks, tool events, message_stop and final", async () => {
    const m = new MockLlmProvider({
      chatScript: [{ content: [{ type: "text", text: "two words" }, { type: "tool_use", id: "t", name: "lookup", input: { q: "y" } }] }],
    });
    const ev = await collect(m.chatStream(req({ tools: [TOOL] })));
    assert.deepEqual(
      ev.map((e) => e.type),
      ["text_delta", "text_delta", "tool_use_start", "tool_input_delta", "tool_use_stop", "message_stop", "final"],
    );
    assert.equal((ev[0] as { text: string }).text + (ev[1] as { text: string }).text, "two words");
  });
});

describe("FailoverLlmProvider.chat()", () => {
  for (const kind of ["rate_limit", "server", "timeout", "network"] as const) {
    it(`fails over on ${kind}, and the response says who served it`, async () => {
      const primary = live("anthropic", { chatScript: [err(kind, kind === "rate_limit" ? 429 : null)] });
      const fallback = live("openai-compatible", { chatScript: [{ content: [{ type: "text", text: "from fallback" }], model: "gpt-5.5" }] });
      const { p, logs } = wrap(primary, fallback);
      const res = await p.chat(req());
      assert.deepEqual(res.content, [{ type: "text", text: "from fallback" }]);
      assert.match(res.meta.notes[0], /Served by gpt-5\.5 after "claude-opus-5-5" failed/);
      assert.equal(primary.mock.chatCalls.length, 1);
      assert.equal(fallback.mock.chatCalls.length, 1);
      assert.equal(lastFailover("lead")?.fallbackModel, "gpt-5.5");
      assert.match(logs[0], /workload=lead model="claude-opus-5-5" failed/);
    });
  }

  for (const kind of ["client", "tool_input"] as const) {
    it(`never fails over on ${kind} (4xx / bad model output)`, async () => {
      const primary = live("anthropic", { chatScript: [err(kind, kind === "client" ? 400 : null)] });
      const fallback = live("openai-compatible", {});
      const { p } = wrap(primary, fallback);
      await assert.rejects(p.chat(req()), (e: unknown) => e instanceof LlmProviderError && e.kind === kind);
      assert.equal(fallback.mock.chatCalls.length, 0);
      assert.equal(lastFailover("lead"), null);
    });
  }

  it("never fails over on the caller's abort", async () => {
    const ac = new AbortController();
    const primary = live("anthropic", {
      chatScript: [
        () => {
          ac.abort(new Error("stopped"));
          return err("network");
        },
      ],
    });
    const fallback = live("openai-compatible", {});
    const { p } = wrap(primary, fallback);
    await assert.rejects(p.chat(req({ signal: ac.signal })));
    assert.equal(fallback.mock.chatCalls.length, 0);
  });

  it("when both fail, the error keeps the fallback's class and names the failover", async () => {
    const { p } = wrap(live("a", { chatScript: [err("server", 503)] }), live("b", { chatScript: [err("rate_limit", 429)] }));
    await assert.rejects(p.chat(req()), (e: unknown) => e instanceof LlmProviderError && e.kind === "rate_limit" && /after failover from "claude-opus-5-5": server \(HTTP 503\)/.test(e.message));
  });
});

describe("FailoverLlmProvider.chatStream()", () => {
  it("fails over when the primary fails before yielding anything", async () => {
    const failing: LlmProvider = {
      name: "anthropic",
      isLive: true,
      isConfigured: () => true,
      generate: async () => "",
      chat: async () => {
        throw err("rate_limit", 429);
      },
      // eslint-disable-next-line require-yield
      chatStream: async function* () {
        throw err("rate_limit", 429);
      },
    };
    const fallback = live("openai-compatible", { chatScript: [{ content: [{ type: "text", text: "ok" }], model: "gpt-5.5" }] });
    const { p } = wrap(failing, fallback);
    const ev = await collect(p.chatStream(req()));
    const final = ev.at(-1) as Extract<ChatStreamEvent, { type: "final" }>;
    assert.equal(final.type, "final");
    assert.match(final.response.meta.notes[0], /Served by gpt-5\.5/);
  });

  it("does NOT fail over once events reached the caller (no duplicated output)", async () => {
    const partial: LlmProvider = {
      name: "anthropic",
      isLive: true,
      isConfigured: () => true,
      generate: async () => "",
      chat: async () => {
        throw err("network");
      },
      chatStream: async function* () {
        yield { type: "text_delta", index: 0, text: "half" };
        throw err("network");
      },
    };
    const fallback = live("openai-compatible", {});
    const { p } = wrap(partial, fallback);
    const seen: ChatStreamEvent[] = [];
    await assert.rejects(
      (async () => {
        for await (const e of p.chatStream(req())) seen.push(e);
      })(),
      (e: unknown) => e instanceof LlmProviderError && e.kind === "network",
    );
    assert.equal(seen.length, 1);
    assert.equal(fallback.mock.chatCalls.length, 0);
  });

  it("does not fail over a 4xx stream failure", async () => {
    const bad: LlmProvider = {
      name: "anthropic",
      isLive: true,
      isConfigured: () => true,
      generate: async () => "",
      chat: async () => {
        throw err("client", 400);
      },
      // eslint-disable-next-line require-yield
      chatStream: async function* () {
        throw err("client", 400);
      },
    };
    const fallback = live("openai-compatible", {});
    const { p } = wrap(bad, fallback);
    await assert.rejects(collect(p.chatStream(req())), (e: unknown) => e instanceof LlmProviderError && e.kind === "client");
    assert.equal(fallback.mock.chatCalls.length, 0);
  });
});
