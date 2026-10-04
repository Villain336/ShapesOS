// ShapesOS — Phase 8: the native agent loop, driven by MockLlmProvider.chat()
// scripts (no network, no database rows: the transcript store is in memory).
// Run: env -u DATABASE_URL npx tsx --test lib/agents/__tests__/loop.test.ts

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { MockLlmProvider, type MockChatStep } from "@/lib/llm/mock";
import type { ChatContentBlock, ChatRequest, ChatToolResultBlock } from "@/lib/llm/types";
import type { LlmWorkload } from "@/lib/llm/router";
import { registerExtraTool, type ToolDef } from "@/lib/chat/tools";
import { memoryTranscriptStore } from "@/lib/agents/runs/transcript";
import {
  MAX_TOKENS_NOTE,
  STOPPED_TEXT,
  initialLoopState,
  runAgentLoop,
  type AgentLoopInput,
  type LoopContext,
  type LoopState,
} from "../loop";

let echoRuns = 0;
let countRuns = 0;
let spendRuns = 0;

const t_echo: ToolDef = {
  name: "t_echo",
  description: "Echo text back.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: { text: { type: "string", description: "Text." } }, required: ["text"] },
  async execute(_ctx, args) {
    echoRuns++;
    return { summary: `echo: ${String(args.text)}`, details: { echoed: args.text } };
  },
};
const t_count: ToolDef = {
  name: "t_count",
  description: "Count a side effect.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    countRuns++;
    return { summary: `counted ${countRuns}` };
  },
};
const t_spend: ToolDef = {
  name: "t_spend",
  description: "Spend money (needs the user's OK).",
  kind: "spend",
  minRole: "viewer",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    spendRuns++;
    return { summary: "spent" };
  },
};
const t_tests: ToolDef = {
  name: "t_tests",
  description: "Run the tests.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    return { summary: "2 tests failed", details: { testsFailed: true } };
  },
};

before(() => {
  for (const t of [t_echo, t_count, t_spend, t_tests]) registerExtraTool(t);
});

function ctx(over: Partial<LoopContext> = {}): LoopContext {
  return {
    projectId: "p1",
    workspaceId: "ws-loop",
    userId: "u1",
    role: "editor",
    confirmed: false,
    agentKey: "lead",
    grant: null,
    ...over,
  };
}

const toolUse = (name: string, input: Record<string, unknown> = {}, id = `tu_${name}`): ChatContentBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});
const text = (t: string): ChatContentBlock => ({ type: "text", text: t });

function lastUser(req: ChatRequest): ChatContentBlock[] {
  const m = req.messages[req.messages.length - 1]!;
  assert.equal(m.role, "user");
  return typeof m.content === "string" ? [text(m.content)] : m.content;
}

function run(script: MockChatStep[], over: Partial<AgentLoopInput> = {}) {
  const provider = new MockLlmProvider({ chatScript: script });
  const store = memoryTranscriptStore();
  const p = runAgentLoop({
    ctx: ctx(),
    system: "You are a test agent.",
    messages: [{ role: "user", content: "do the thing" }],
    ...over,
    deps: { provider, store, persistEvents: false, ...(over.deps ?? {}) },
  });
  return { provider, store, p };
}

describe("agent loop: native tool protocol", () => {
  it("tool_use → tool_result → final answer", async () => {
    echoRuns = 0;
    const { provider, p } = run([
      { content: [text("Let me check."), toolUse("t_echo", { text: "hi" })] },
      (req) => {
        const r = lastUser(req)[0] as ChatToolResultBlock;
        assert.equal(r.type, "tool_result");
        assert.equal(r.toolUseId, "tu_t_echo");
        assert.match(String(r.content), /echo: hi/);
        assert.match(String(r.content), /"echoed":"hi"/, "the tool's details reach the model");
        assert.ok(!r.isError);
        return { content: [text("All done.")] };
      },
    ]);
    const res = await p;
    assert.equal(res.status, "done");
    assert.equal(res.finalText, "All done.");
    assert.equal(echoRuns, 1);
    assert.equal(res.calls[0]?.status, "executed");
    assert.equal(res.calls[0]?.toolUseId, "tu_t_echo");
    // System + tools are cached; thinking adaptive; tools are native.
    const req = provider.chatCalls[0]!;
    assert.equal(req.cache, true);
    assert.equal(req.cacheConversation, true);
    assert.equal(req.thinking, "adaptive");
    assert.ok(req.tools?.some((t) => t.name === "t_echo"));
    assert.deepEqual(req.serverTools, ["web_search", "web_fetch"], "a null grant includes web");
  });

  it("refuses a tool outside the grant even when the model names it", async () => {
    echoRuns = 0;
    const { provider, p } = run(
      [{ content: [toolUse("t_echo", { text: "x" })] }, { content: [text("ok")] }],
      { ctx: ctx({ grant: ["workspace"] }) },
    );
    const res = await p;
    assert.equal(echoRuns, 0, "never executed");
    assert.equal(res.calls[0]?.status, "denied");
    assert.ok(!provider.chatCalls[0]!.tools?.some((t) => t.name === "t_echo"), "hidden from the model");
    assert.deepEqual(provider.chatCalls[0]!.serverTools, [], "no web group, no server web tools");
    const r = lastUser(provider.chatCalls[1]!)[0] as ChatToolResultBlock;
    assert.equal(r.isError, true);
    assert.match(String(r.content), /^Refused/);
  });

  it("holds a non-safe tool for confirmation and ends the turn", async () => {
    spendRuns = 0;
    const { provider, p, store } = run([{ content: [toolUse("t_spend")] }, { content: [text("never reached")] }], {
      ctx: ctx({ runId: "run-confirm" }),
    });
    const res = await p;
    assert.equal(res.status, "awaiting_confirmation");
    assert.equal(res.proposal?.tool, "t_spend");
    assert.equal(res.proposal?.runId, "run-confirm");
    assert.match(res.finalText, /Reply \*\*yes\*\*/);
    assert.equal(spendRuns, 0);
    assert.equal(provider.chatCalls.length, 1, "no further model call");
    const saved = (await store.load("ws-loop", "run-confirm")) as LoopState;
    const last = saved.messages[saved.messages.length - 1]!;
    const r = (last.content as ChatContentBlock[])[0] as ChatToolResultBlock;
    assert.match(String(r.content), /waiting for the user's OK/);
  });

  it("stops before the model call when the run is already stopped", async () => {
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    const { provider, p } = run([{ content: [text("no")] }], { ctx: ctx({ signal: ac.signal }) });
    const res = await p;
    assert.equal(res.status, "cancelled");
    assert.equal(res.finalText, STOPPED_TEXT);
    assert.equal(provider.chatCalls.length, 0);
  });

  it("stops before the tool call when Stop lands during the model call", async () => {
    echoRuns = 0;
    const ac = new AbortController();
    const { p } = run(
      [
        () => {
          ac.abort(new Error("stop"));
          return { content: [toolUse("t_echo", { text: "x" })] };
        },
      ],
      { ctx: ctx({ signal: ac.signal }) },
    );
    const res = await p;
    assert.equal(res.status, "cancelled");
    assert.equal(echoRuns, 0);
  });

  it("caps: steps, cost and time", async () => {
    const forever: MockChatStep = () => ({ content: [toolUse("t_echo", { text: "again" }, `tu_${Math.random()}`)] });
    const steps = await run([forever], { limits: { maxSteps: 3 } }).p;
    assert.equal(steps.status, "capped");
    assert.equal(steps.cap, "steps");
    assert.equal(steps.state.steps, 3);
    assert.match(steps.finalText, /step limit/);

    const costly: MockChatStep = () => ({ content: [toolUse("t_echo", { text: "x" }, `tu_${Math.random()}`)], costMicroUsd: 600 });
    const cost = await run([costly], { limits: { maxCostMicroUsd: 1000 } }).p;
    assert.equal(cost.cap, "cost");
    assert.equal(cost.state.steps, 2);

    let t = 0;
    const time = await run([forever], { limits: { maxMs: 1000 }, deps: { now: () => (t += 400) } }).p;
    assert.equal(time.cap, "time");
  });

  it("max_tokens: continues once with a note, then stops with a cut-off note", async () => {
    const once = run([
      { content: [text("Part one")], stopReason: "max_tokens" },
      (req) => {
        const blocks = lastUser(req);
        assert.ok(blocks.some((b) => b.type === "text" && b.text === MAX_TOKENS_NOTE));
        return { content: [text("Part two.")] };
      },
    ]);
    const a = await once.p;
    assert.equal(a.status, "done");
    assert.equal(a.finalText, "Part two.");

    const twice = await run([{ content: [text("cut")], stopReason: "max_tokens" }]).p;
    assert.equal(twice.status, "done");
    assert.match(twice.finalText, /cut off at the output limit/);
  });

  it("max_tokens with a cut-off tool call: the call is never run", async () => {
    echoRuns = 0;
    const { provider, p } = run([
      { content: [toolUse("t_echo", { text: "trunc" })], stopReason: "max_tokens" },
      { content: [text("ok")] },
    ]);
    await p;
    assert.equal(echoRuns, 0);
    const r = lastUser(provider.chatCalls[1]!)[0] as ChatToolResultBlock;
    assert.equal(r.isError, true);
    assert.match(String(r.content), /INVALID_JSON/);
  });

  it("pause_turn: re-sends the paused turn without a new user message", async () => {
    const paused: ChatContentBlock = { type: "opaque", provider: "anthropic", kind: "server_tool_use", raw: { type: "server_tool_use", id: "s1" } };
    const { provider, p } = run([
      { content: [paused], stopReason: "pause_turn" },
      (req) => {
        const last = req.messages[req.messages.length - 1]!;
        assert.equal(last.role, "assistant", "the paused assistant turn is last");
        return { content: [text("Found it.")] };
      },
    ]);
    const res = await p;
    assert.equal(res.finalText, "Found it.");
    assert.equal(provider.chatCalls.length, 2);
  });

  it("refusal: surfaced, tools never run", async () => {
    echoRuns = 0;
    const res = await run([
      {
        content: [toolUse("t_echo", { text: "x" })],
        stopReason: "refusal",
        stopDetails: { category: "policy", explanation: "not allowed" },
      },
    ]).p;
    assert.equal(res.status, "refused");
    assert.match(res.finalText, /declined.*not allowed/);
    assert.equal(echoRuns, 0);
  });

  it("compacts client-side when a call's input passes the threshold", async () => {
    const { provider, p } = run(
      [
        { content: [toolUse("t_echo", { text: "big" })], usage: { inputTokens: 500, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        { content: [text("SUMMARY: echoed big")] },
        { content: [text("Finished after compaction.")] },
      ],
      { limits: { compactAtTokens: 100 } },
    );
    const res = await p;
    assert.equal(res.finalText, "Finished after compaction.");
    assert.equal(provider.chatCalls[1]!.toolChoice, "none", "the summary call runs no tools");
    const after = provider.chatCalls[2]!;
    assert.equal(after.messages.length, 1, "one user message replaces the transcript");
    assert.match(String(after.messages[0]!.content), /do the thing[\s\S]*SUMMARY: echoed big/);
    assert.equal(res.state.compactions, 1);
  });

  it("server-side compaction (meta.compaction) skips the client-side summary", async () => {
    const { provider, p } = run(
      [
        {
          content: [toolUse("t_echo", { text: "big" })],
          usage: { inputTokens: 500, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          meta: { serverToolsSent: [], notes: [], compaction: "server" },
        },
        { content: [text("done")] },
      ],
      { limits: { compactAtTokens: 100 } },
    );
    await p;
    assert.equal(provider.chatCalls.length, 2);
    assert.equal(provider.chatCalls[0]!.compaction, true, "compaction is requested from the provider");
  });

  it("resumes a handed-off run and never re-runs a saved tool", async () => {
    countRuns = 0;
    const provider = new MockLlmProvider({
      chatScript: [{ content: [toolUse("t_count")] }, { content: [text("resumed and done")] }],
    });
    const store = memoryTranscriptStore();
    const first = await runAgentLoop({
      ctx: ctx({ runId: "run-resume" }),
      system: "sys",
      messages: [{ role: "user", content: "count" }],
      handoffAt: 0,
      deps: { provider, store, persistEvents: false },
    });
    assert.equal(first.status, "handoff");
    assert.equal(countRuns, 1);
    // A different worker picks it up from the store.
    const second = await runAgentLoop({ ctx: ctx({ runId: "run-resume" }), deps: { provider, store, persistEvents: false } });
    assert.equal(second.status, "done");
    assert.equal(second.finalText, "resumed and done");
    assert.equal(countRuns, 1, "the saved tool result is reused, not re-run");
  });

  it("resumed mid-batch: only the tool without a saved result runs", async () => {
    countRuns = 0;
    echoRuns = 0;
    const store = memoryTranscriptStore();
    const state = initialLoopState({ system: "sys", messages: [{ role: "user", content: "go" }], workload: "lead" });
    state.steps = 1;
    state.messages.push({ role: "assistant", content: [toolUse("t_count", {}, "a"), toolUse("t_echo", { text: "b" }, "b")] });
    state.toolResults.a = { type: "tool_result", toolUseId: "a", content: "counted earlier" };
    await store.save("ws-loop", "run-mid", state, 1);
    const provider = new MockLlmProvider({
      chatScript: [
        (req) => {
          const blocks = lastUser(req) as ChatToolResultBlock[];
          assert.deepEqual(blocks.map((b) => b.toolUseId), ["a", "b"]);
          assert.equal(blocks[0]!.content, "counted earlier");
          return { content: [text("ok")] };
        },
      ],
    });
    const res = await runAgentLoop({ ctx: ctx({ runId: "run-mid" }), deps: { provider, store, persistEvents: false } });
    assert.equal(res.status, "done");
    assert.equal(countRuns, 0, "t_count already had a result");
    assert.equal(echoRuns, 1);
  });

  it("a finished run returns its outcome without calling the model again", async () => {
    const store = memoryTranscriptStore();
    const provider = new MockLlmProvider({ chatScript: [{ content: [text("first")] }] });
    await runAgentLoop({ ctx: ctx({ runId: "run-done" }), system: "s", messages: [{ role: "user", content: "x" }], deps: { provider, store, persistEvents: false } });
    const again = await runAgentLoop({ ctx: ctx({ runId: "run-done" }), deps: { provider, store, persistEvents: false } });
    assert.equal(again.finalText, "first");
    assert.equal(provider.chatCalls.length, 1);
  });

  it("build mode runs on the code workload and escalates after two failing test cycles", async () => {
    const workloads: LlmWorkload[] = [];
    let i = 0;
    const provider = new MockLlmProvider({
      chatScript: [() => (i++ < 2 ? { content: [toolUse("t_tests", {}, `t${i}`)] } : { content: [text("green")] })],
    });
    const res = await runAgentLoop({
      ctx: ctx({ agentKey: "actor", grant: null }),
      system: "s",
      messages: [{ role: "user", content: "fix the build" }],
      mode: "build",
      deps: {
        provider: (w) => {
          workloads.push(w);
          return provider;
        },
        store: memoryTranscriptStore(),
        persistEvents: false,
      },
    });
    assert.equal(res.finalText, "green");
    assert.deepEqual(workloads, ["code", "code", "code_max"]);
    assert.equal(res.state.escalated, true);
  });

  it("an extra stop check (mission kill switch) ends the run", async () => {
    const res = await run([{ content: [text("no")] }], { extraStopCheck: async () => "Stopped: the mission is paused." }).p;
    assert.equal(res.status, "cancelled");
    assert.equal(res.finalText, "Stopped: the mission is paused.");
  });

  it("a tool filter hides and refuses tools outside a run's declared list", async () => {
    echoRuns = 0;
    const { provider, p } = run([{ content: [toolUse("t_echo", { text: "x" })] }, { content: [text("ok")] }], {
      toolFilter: (name) => name === "t_count",
    });
    const res = await p;
    assert.deepEqual(provider.chatCalls[0]!.tools?.map((t) => t.name), ["t_count"]);
    assert.equal(res.calls[0]?.status, "denied");
    assert.equal(echoRuns, 0);
  });

  it("streams text deltas through onEvent and withholds text a stream guard blocks", async () => {
    const deltas: string[] = [];
    await run([{ content: [text("hello there world")] }], {
      onEvent: (e) => {
        if (e.type === "text_delta") deltas.push(e.text);
      },
    }).p;
    assert.equal(deltas.join(""), "hello there world");

    const guarded: string[] = [];
    await run([{ content: [text("this is cheap stuff here")] }], {
      streamGuard: (t) => /\bcheap\b/i.test(t),
      onEvent: (e) => {
        if (e.type === "text_delta") guarded.push(e.text);
      },
    }).p;
    assert.ok(!guarded.join("").includes("cheap"), "the banned word never streams");
  });
});
