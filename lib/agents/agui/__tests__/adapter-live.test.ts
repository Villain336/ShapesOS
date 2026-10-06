// ShapesOS — Phase 8: the AG-UI adapter's live path (tailing the run timeline),
// with the turn, the timeline and the shared state stubbed (no DB, no model).
// Run: env -u DATABASE_URL npx tsx --test lib/agents/agui/__tests__/adapter-live.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventType, assertAguiSequence, MARKETR_CUSTOM_NAMES, type AguiEvent } from "../events";
import { aguiStreamResponse, resumeChatTurnAgui, streamChatTurnAgui, type TailedRunEvent } from "../adapter";
import type { AgentTurnOutput } from "@/lib/chat/agent";

const REQ = { projectId: "p", workspaceId: "ws", userId: "u", role: "editor" as const, threadId: "th", userContent: "hi", runId: "agui1" };

function timeline() {
  const events: TailedRunEvent[] = [];
  return {
    events,
    push(type: string, payload: Record<string, unknown>) {
      events.push({ seq: events.length, type, summary: String(payload.text ?? payload.tool ?? type), payload });
    },
    list: async (_ws: string, _run: string, after: number) => events.filter((e) => e.seq > after),
  };
}

async function collect(deps: Parameters<typeof streamChatTurnAgui>[1]): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  for await (const e of streamChatTurnAgui(REQ, { loadSharedState: async () => ({}), logSink: () => undefined, pollMs: 5, ...deps })) out.push(e);
  return out;
}

describe("AG-UI live stream", () => {
  it("maps streamed text and tool events from the run, in order", async () => {
    const tl = timeline();
    const events = await collect({
      listRunEvents: tl.list,
      runTrackedTurn: async (_input, { onRunCreated }) => {
        onRunCreated("run1");
        tl.push("text", { kind: "text_delta", step: 1, text: "Let me " });
        await new Promise((r) => setTimeout(r, 20));
        tl.push("text", { kind: "text_delta", step: 1, text: "check." });
        tl.push("agui", { kind: "tool_start", toolUseId: "tu1", tool: "get_keywords", args: { limit: "5" } });
        tl.push("agui", { kind: "tool_result", toolUseId: "tu1", tool: "get_keywords", status: "executed", summary: "3 keywords" });
        tl.push("gate", { kind: "tool_result", toolUseId: "tu2", tool: "run_workflow", status: "pending_confirmation" });
        tl.push("text", { kind: "text_delta", step: 2, text: "Done." });
        return { assistantText: "Done.", toolCalls: [], threadTitle: null, runId: "run1" } satisfies AgentTurnOutput & { runId: string };
      },
    });
    assertAguiSequence(events);
    const kinds = events.map((e) => e.type);
    assert.deepEqual(kinds.slice(0, 2), [EventType.RUN_STARTED, EventType.STATE_SNAPSHOT]);
    const text = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT).map((e) => (e as { delta: string }).delta);
    assert.deepEqual(text, ["Let me ", "check.", "Done."], "streamed once each; the final text matched, so nothing is repeated");
    const toolStart = kinds.indexOf(EventType.TOOL_CALL_START);
    assert.ok(toolStart > kinds.indexOf(EventType.TEXT_MESSAGE_END), "the step's text closes before its tool call");
    const results = events.filter((e) => e.type === EventType.TOOL_CALL_RESULT) as Array<{ content: string; toolCallId: string }>;
    assert.equal(results[0]!.content, "3 keywords");
    assert.ok(events.some((e) => e.type === EventType.CUSTOM && (e as { name: string }).name === MARKETR_CUSTOM_NAMES.toolProposal));
    assert.equal(kinds[kinds.length - 1], EventType.RUN_FINISHED);
  });

  it("a final text that differs from the stream (style refusal, proposal) arrives as its own message", async () => {
    const tl = timeline();
    const events = await collect({
      listRunEvents: tl.list,
      runTrackedTurn: async (_i, { onRunCreated }) => {
        onRunCreated("run2");
        tl.push("text", { kind: "text_delta", step: 1, text: "Something" });
        return { assistantText: "I can't deliver that response as written.", toolCalls: [], threadTitle: null, runId: "run2" };
      },
    });
    assertAguiSequence(events);
    const starts = events.filter((e) => e.type === EventType.TEXT_MESSAGE_START);
    assert.equal(starts.length, 2);
    const last = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT).map((e) => (e as { delta: string }).delta).slice(1).join("");
    assert.equal(last, "I can't deliver that response as written.");
  });

  it("a queued (handed-off) turn keeps streaming until its run ends", async () => {
    const tl = timeline();
    let status = "running";
    const events = await collect({
      listRunEvents: tl.list,
      getRunStatus: async () => status,
      latestAssistantText: async () => "Worker finished.",
      runTrackedTurn: async (_i, { onRunCreated }) => {
        onRunCreated("run3");
        setTimeout(() => {
          tl.push("text", { kind: "text_delta", step: 2, text: "Worker finished." });
          status = "succeeded";
        }, 30);
        return { assistantText: "", toolCalls: [], threadTitle: null, queued: true, runId: "run3" };
      },
    });
    assertAguiSequence(events);
    assert.ok(events.some((e) => e.type === EventType.CUSTOM && (e as { name: string }).name === MARKETR_CUSTOM_NAMES.queued));
    const text = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT).map((e) => (e as { delta: string }).delta).join("");
    assert.equal(text, "Worker finished.");
  });

  it("a failed turn ends with RUN_ERROR", async () => {
    const events = await collect({
      listRunEvents: async () => [],
      runTrackedTurn: async () => {
        throw new Error("provider down");
      },
    });
    assertAguiSequence(events);
    assert.equal(events[events.length - 1]!.type, EventType.RUN_ERROR);
  });
});

describe("AG-UI stream across a server restart (deploy PR)", () => {
  it("a draining server ends a handed-off turn's tail with marketr.reconnect at a clean boundary", async () => {
    const tl = timeline();
    let draining = false;
    const cursors: Array<[string, number]> = [];
    const events = await collect({
      listRunEvents: tl.list,
      getRunStatus: async () => "running",
      onCursor: (r, seq) => cursors.push([r, seq]),
      shouldReconnect: () => draining,
      runTrackedTurn: async (_i, { onRunCreated }) => {
        onRunCreated("run7");
        tl.push("text", { kind: "text_delta", step: 1, text: "Work" });
        tl.push("text", { kind: "text_delta", step: 1, text: "ing" });
        draining = true; // SIGTERM arrives; the turn was handed to the worker
        return { assistantText: "", toolCalls: [], threadTitle: null, queued: true, runId: "run7" };
      },
    });
    const last = events[events.length - 1] as { type: string; name?: string; value?: Record<string, unknown> };
    assert.equal(last.type, EventType.CUSTOM);
    assert.equal(last.name, MARKETR_CUSTOM_NAMES.reconnect);
    assert.deepEqual(last.value, { runId: "run7", after: 1, aguiRunId: "agui1" });
    assert.ok(!events.some((e) => e.type === EventType.RUN_FINISHED), "the turn is not over: the client resumes it");
    assert.deepEqual(cursors, [["run7", 0], ["run7", 1]], "the cursor moves before each run event is mapped");
  });

  it("resumeChatTurnAgui continues the same messages after the cursor and finishes the turn", async () => {
    const tl = timeline();
    tl.push("text", { kind: "text_delta", step: 1, text: "Work" }); // seq 0 (already delivered)
    tl.push("text", { kind: "text_delta", step: 1, text: "ing" }); // seq 1 (already delivered)
    tl.push("text", { kind: "text_delta", step: 1, text: " done." }); // seq 2 (new)
    const out: AguiEvent[] = [];
    for await (const e of resumeChatTurnAgui(
      { workspaceId: "ws", threadId: "th", agentRunId: "run7", aguiRunId: "agui1", afterSeq: 1 },
      { listRunEvents: tl.list, getRunStatus: async () => "succeeded", latestAssistantText: async () => "Working done.", logSink: () => undefined, pollMs: 5 },
    ))
      out.push(e);
    const contents = out.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT) as Array<{ messageId: string; delta: string }>;
    assert.equal(contents[0]!.delta, " done.", "nothing at or before the cursor is replayed");
    assert.equal(contents[0]!.messageId, "agui1:msg:run7:1", "same message id as the original stream");
    // The client already shows "Working": the resumed stream continues that
    // open message (no second START) and the final reconcile finds the full
    // text there — it must not send the answer again as a new message.
    assert.deepEqual(contents.map((c) => c.delta), [" done."], "the answer is delivered exactly once");
    assert.ok(!out.some((e) => e.type === EventType.TEXT_MESSAGE_START), "the open message is continued, not restarted");
    assert.deepEqual(
      out.filter((e) => e.type === EventType.TEXT_MESSAGE_END).map((e) => (e as { messageId: string }).messageId),
      ["agui1:msg:run7:1"],
    );
    assert.equal(out[out.length - 1]!.type, EventType.RUN_FINISHED);
  });

  it("a resumed stream does not re-announce a tool call the client already saw", async () => {
    const tl = timeline();
    tl.push("tool", { kind: "tool_start", toolUseId: "t1", tool: "search", args: { q: "x" } }); // seq 0 (delivered)
    tl.push("tool", { kind: "tool_result", toolUseId: "t1", tool: "search", status: "executed", summary: "3 hits" }); // seq 1 (new)
    tl.push("text", { kind: "text_delta", step: 2, text: "Found 3." }); // seq 2 (new)
    const out: AguiEvent[] = [];
    for await (const e of resumeChatTurnAgui(
      { workspaceId: "ws", threadId: "th", agentRunId: "run7", aguiRunId: "agui1", afterSeq: 0 },
      { listRunEvents: tl.list, getRunStatus: async () => "succeeded", latestAssistantText: async () => "Found 3.", logSink: () => undefined, pollMs: 5 },
    ))
      out.push(e);
    assert.ok(!out.some((e) => e.type === EventType.TOOL_CALL_START), "TOOL_CALL_START was delivered before the cursor");
    assert.equal(out.filter((e) => e.type === EventType.TOOL_CALL_RESULT).length, 1);
    const texts = out.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT).map((e) => (e as { delta: string }).delta);
    assert.deepEqual(texts, ["Found 3."]);
  });

  it("the SSE response stamps the run cursor as the event id and turns marketr.reconnect into `event: reconnect`", async () => {
    const tl = timeline();
    const res = aguiStreamResponse(
      (hooks) =>
        streamChatTurnAgui(REQ, {
          loadSharedState: async () => ({}),
          logSink: () => undefined,
          pollMs: 5,
          listRunEvents: tl.list,
          getRunStatus: async () => "running",
          onCursor: hooks.onCursor,
          shouldReconnect: () => true,
          runTrackedTurn: async (_i, { onRunCreated }) => {
            onRunCreated("run8");
            tl.push("text", { kind: "text_delta", step: 1, text: "Hi" });
            return { assistantText: "", toolCalls: [], threadTitle: null, queued: true, runId: "run8" };
          },
        }),
      { sse: { register: () => () => undefined } },
    );
    const text = await res.text();
    assert.match(text, /^retry: 2000\n\n/);
    assert.match(text, /id: run8:0\ndata: \{"type":"TEXT_MESSAGE_CONTENT"/);
    assert.match(text, /event: reconnect\ndata: \{"runId":"run8","after":0,"aguiRunId":"agui1"\}\n\n$/);
  });
});
