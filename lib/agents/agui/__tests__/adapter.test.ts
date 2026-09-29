// Marketr — Phase 16 slice 1: AG-UI adapter contract tests.
// Run: npx tsx --test lib/agents/agui/__tests__/adapter.test.ts
//
// The agent's turn executor is stubbed (deps.runTurn) so these tests never
// touch prisma or an LLM provider — they assert the event contract only.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EventType, assertAguiSequence, isValidAguiEvent, MARKETR_CUSTOM_NAMES, type AguiEvent } from "../events";
import {
  streamChatTurnAgui,
  chunkTextFixed,
  AguiEmitter,
  type AguiTurnRequest,
} from "../adapter";
import type { AgentTurnOutput } from "@/lib/chat/agent";

const REQ: AguiTurnRequest = {
  projectId: "p1",
  workspaceId: "ws1",
  userId: "u1",
  role: "editor",
  threadId: "thread1",
  userContent: "hello",
};

async function collect(
  req: AguiTurnRequest,
  runTurn: () => Promise<AgentTurnOutput>,
): Promise<{ events: AguiEvent[]; logLines: string[] }> {
  const logLines: string[] = [];
  const events: AguiEvent[] = [];
  for await (const e of streamChatTurnAgui({ ...req, runId: "run_1" }, {
    runTurn,
    chunkText: (t) => chunkTextFixed(t, 4),
    logSink: (line) => logLines.push(line),
  })) {
    events.push(e);
  }
  return { events, logLines };
}

function plainTurn(text: string): AgentTurnOutput {
  return { assistantText: text, toolCalls: [], threadTitle: null };
}

describe("streamChatTurnAgui — plain text turn", () => {
  it("emits the protocol-ordered sequence and logs every event", async () => {
    const { events, logLines } = await collect(REQ, async () => plainTurn("hello world, this is a test"));

    const kinds = events.map((e) => e.type);
    assert.deepEqual(kinds, [
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);

    // Reassembled content equals the turn text.
    const body = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => (e as { delta: string }).delta)
      .join("");
    assert.equal(body, "hello world, this is a test");

    // Required protocol fields present on each event.
    for (const e of events) assert.equal(isValidAguiEvent(e), true, `invalid: ${e.type}`);
    const started = events[0];
    assert.equal((started as { threadId: string }).threadId, "thread1");
    assert.equal((started as { runId: string }).runId, "run_1");

    // Ordering invariants hold.
    assert.doesNotThrow(() => assertAguiSequence(events));

    // One structured log line per event, sequential.
    assert.equal(logLines.length, events.length);
    const parsed = logLines.map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((p) => p.seq), parsed.map((_, i) => i));
    assert.ok(parsed.every((p) => p.component === "agui" && p.runId === "run_1" && p.threadId === "thread1"));
  });
});

describe("streamChatTurnAgui — tool calls", () => {
  it("maps each tool call to START → ARGS → END → RESULT before the text", async () => {
    const { events } = await collect(REQ, async () => ({
      assistantText: "done",
      toolCalls: [
        { tool: "keywords.list", args: { limit: 5 }, resultSummary: "5 keywords", status: "executed" },
        { tool: "content.draft", args: { topic: "x" }, resultSummary: "", status: "pending_confirmation" },
      ],
      threadTitle: null,
    }));

    assert.doesNotThrow(() => assertAguiSequence(events));
    for (const e of events) assert.equal(isValidAguiEvent(e), true, `invalid: ${e.type}`);

    const kinds = events.map((e) => e.type);
    assert.deepEqual(kinds, [
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.CUSTOM, // pending_confirmation → marketr.toolProposal
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);

    const start0 = events[1] as { toolCallName: string; toolCallId: string };
    assert.equal(start0.toolCallName, "keywords.list");
    assert.ok(start0.toolCallId.length > 0);

    const args0 = events[2] as { toolCallId: string; delta: string };
    assert.equal(args0.toolCallId, start0.toolCallId);
    assert.deepEqual(JSON.parse(args0.delta), { limit: 5 });

    const result0 = events[4] as { toolCallId: string; content: string };
    assert.equal(result0.toolCallId, start0.toolCallId);
    assert.equal(result0.content, "5 keywords");

    const custom = events[9] as { name: string; value: { tool: string } };
    assert.equal(custom.name, MARKETR_CUSTOM_NAMES.toolProposal);
    assert.equal(custom.value.tool, "content.draft");
  });
});

describe("streamChatTurnAgui — errors", () => {
  it("maps a thrown turn to RUN_ERROR with no text events", async () => {
    const { events } = await collect(REQ, async () => {
      throw new Error("provider down");
    });
    const kinds = events.map((e) => e.type);
    assert.deepEqual(kinds, [EventType.RUN_STARTED, EventType.RUN_ERROR]);
    const err = events[1] as { message: string };
    assert.equal(err.message, "provider down");
    for (const e of events) assert.equal(isValidAguiEvent(e), true, `invalid: ${e.type}`);
    assert.doesNotThrow(() => assertAguiSequence(events));
  });
});

describe("chunkTextFixed", () => {
  it("splits text into fixed chunks and returns [] for empty text", () => {
    assert.deepEqual(chunkTextFixed("abcdefgh", 3), ["abc", "def", "gh"]);
    assert.deepEqual(chunkTextFixed("", 3), []);
  });
});

describe("AguiEmitter — orchestrator plug-in point", () => {
  it("stamps run correlation and emits state events", () => {
    const lines: string[] = [];
    const emitter = new AguiEmitter(
      { runId: "run_m", threadId: "thread_m", workspaceId: "ws_m" },
      (l) => lines.push(l),
    );
    emitter.stateSnapshot({ mission: "m1", step: 0 });
    emitter.stateDelta([{ op: "replace", path: "/step", value: 1 }]);

    assert.equal(emitter.events.length, 2);
    assert.equal(emitter.events[0].type, EventType.STATE_SNAPSHOT);
    assert.equal(emitter.events[1].type, EventType.STATE_DELTA);
    for (const e of emitter.events) {
      assert.equal(isValidAguiEvent(e), true, `invalid: ${e.type}`);
      assert.equal(e.metadata?.marketr.runId, "run_m");
    }
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).seq, 0);
  });
});
