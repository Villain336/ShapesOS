// ShapesOS — Phase 17 (latency): the AG-UI tail on the in-process run-event
// bus (lib/agents/runs/live-events.ts). No DB, no model: the "database" is an
// in-memory timeline and the bus is the real module.
// Run: env -u DATABASE_URL npx tsx --test lib/agents/agui/__tests__/adapter-bus.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventType, assertAguiSequence, MARKETR_CUSTOM_NAMES, type AguiEvent } from "../events";
import { resumeChatTurnAgui, streamChatTurnAgui, type TailedRunEvent } from "../adapter";
import {
  _resetLiveRunEventsForTests,
  claimRunProducer,
  hasRunProducer,
  publishRunEvent,
  runListenerCount,
  subscribeRunEvents,
} from "@/lib/agents/runs/live-events";
import type { AgentTurnOutput } from "@/lib/chat/agent";

const REQ = { projectId: "p", workspaceId: "ws", userId: "u", role: "editor" as const, threadId: "th", userContent: "hi", runId: "agui1" };

/** The durable timeline (the database) that ALSO publishes to the bus, as appendAgentRunEvent does. */
function timeline(runId: string) {
  const events: TailedRunEvent[] = [];
  let reads = 0;
  return {
    events,
    get reads() {
      return reads;
    },
    write(type: string, payload: Record<string, unknown>, opts: { publish?: boolean } = {}) {
      const ev = { seq: events.length, type, summary: String(payload.text ?? payload.tool ?? type), payload };
      events.push(ev);
      if (opts.publish !== false) publishRunEvent(runId, ev);
      return ev;
    },
    list: async (_ws: string, _run: string, after: number) => {
      reads++;
      return events.filter((e) => e.seq > after);
    },
  };
}

const deltas = (events: AguiEvent[]) => events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT).map((e) => (e as { delta: string }).delta);

beforeEach(() => _resetLiveRunEventsForTests());

describe("live-events bus", () => {
  it("delivers to the run's listeners, drops empty sets, counts producers", () => {
    const got: number[] = [];
    const off = subscribeRunEvents("r1", (e) => got.push(e.seq));
    publishRunEvent("r1", { seq: 0, type: "text", summary: "a", payload: null });
    publishRunEvent("r2", { seq: 0, type: "text", summary: "b", payload: null });
    assert.deepEqual(got, [0]);
    assert.equal(runListenerCount("r1"), 1);
    off();
    assert.equal(runListenerCount("r1"), 0);
    const release = claimRunProducer("r1");
    const release2 = claimRunProducer("r1");
    assert.equal(hasRunProducer("r1"), true);
    release();
    assert.equal(hasRunProducer("r1"), true, "two claims, one release");
    release2();
    release2();
    assert.equal(hasRunProducer("r1"), false);
  });

  it("a throwing listener never breaks the writer", () => {
    subscribeRunEvents("r1", () => {
      throw new Error("boom");
    });
    assert.doesNotThrow(() => publishRunEvent("r1", { seq: 0, type: "text", summary: "a", payload: null }));
  });
});

describe("AG-UI tail on the bus", () => {
  it("forwards deltas the moment they are written — no poll wait (pollMs is 60 s; the test would hang on the poll)", async () => {
    const tl = timeline("run1");
    const stamps: number[] = [];
    const t0 = Date.now();
    const events: AguiEvent[] = [];
    for await (const e of streamChatTurnAgui(REQ, {
      loadSharedState: async () => ({}),
      logSink: () => undefined,
      pollMs: 60_000,
      listRunEvents: tl.list,
      runTrackedTurn: async (_i, { onRunCreated }) => {
        onRunCreated("run1");
        const release = claimRunProducer("run1");
        try {
          tl.write("text", { kind: "text_delta", step: 1, text: "Hello " });
          await new Promise((r) => setTimeout(r, 30));
          tl.write("text", { kind: "text_delta", step: 1, text: "world." });
          await new Promise((r) => setTimeout(r, 30));
          return { assistantText: "Hello world.", toolCalls: [], threadTitle: null, runId: "run1" } satisfies AgentTurnOutput & { runId: string };
        } finally {
          release();
        }
      },
    })) {
      events.push(e);
      if (e.type === EventType.TEXT_MESSAGE_CONTENT) stamps.push(Date.now() - t0);
    }
    assertAguiSequence(events);
    assert.deepEqual(deltas(events), ["Hello ", "world."]);
    assert.ok(stamps[0]! < 1_000 && stamps[1]! < 1_000, `deltas arrived at ${stamps.join(", ")} ms — far below the 60 s poll`);
    assert.ok(stamps[1]! - stamps[0]! < 500, "the second delta did not wait for a poll either");
    assert.ok(tl.reads <= 2, `the database was read ${tl.reads} times (the initial look and the final catch-up at most), not polled`);
    assert.equal(runListenerCount("run1"), 0, "the tail unsubscribed when the stream ended");
  });

  it("falls back to the database poll when the run works in another process (no producer here)", async () => {
    const tl = timeline("run2");
    const events: AguiEvent[] = [];
    for await (const e of streamChatTurnAgui(REQ, {
      loadSharedState: async () => ({}),
      logSink: () => undefined,
      pollMs: 5,
      listRunEvents: tl.list,
      runTrackedTurn: async (_i, { onRunCreated }) => {
        onRunCreated("run2");
        // Written by a worker elsewhere: rows land, nothing reaches this bus.
        tl.write("text", { kind: "text_delta", step: 1, text: "From " }, { publish: false });
        await new Promise((r) => setTimeout(r, 30));
        tl.write("text", { kind: "text_delta", step: 1, text: "afar." }, { publish: false });
        await new Promise((r) => setTimeout(r, 30));
        return { assistantText: "From afar.", toolCalls: [], threadTitle: null, runId: "run2" };
      },
    }))
      events.push(e);
    assertAguiSequence(events);
    assert.deepEqual(deltas(events), ["From ", "afar."]);
    assert.ok(tl.reads >= 3, `the database was polled (${tl.reads} reads)`);
  });

  it("fills a gap from the database and never emits twice or out of order", async () => {
    const tl = timeline("run3");
    const events: AguiEvent[] = [];
    for await (const e of streamChatTurnAgui(REQ, {
      loadSharedState: async () => ({}),
      logSink: () => undefined,
      pollMs: 60_000,
      listRunEvents: tl.list,
      runTrackedTurn: async (_i, { onRunCreated }) => {
        onRunCreated("run3");
        const release = claimRunProducer("run3");
        try {
          tl.write("text", { kind: "text_delta", step: 1, text: "a " }); // seq 0 on the bus
          tl.write("text", { kind: "text_delta", step: 1, text: "b " }, { publish: false }); // seq 1 missed (gap)
          tl.write("text", { kind: "text_delta", step: 1, text: "c " }); // seq 2 on the bus → gap → database
          publishRunEvent("run3", tl.events[0]!); // a duplicate of seq 0
          await new Promise((r) => setTimeout(r, 30));
          return { assistantText: "a b c ", toolCalls: [], threadTitle: null, runId: "run3" };
        } finally {
          release();
        }
      },
    }))
      events.push(e);
    assertAguiSequence(events);
    assert.deepEqual(deltas(events), ["a ", "b ", "c "]);
  });

  it("maps the thinking state to CUSTOM marketr.thinking (never any reasoning text)", async () => {
    const tl = timeline("run4");
    const events: AguiEvent[] = [];
    for await (const e of streamChatTurnAgui(REQ, {
      loadSharedState: async () => ({}),
      logSink: () => undefined,
      pollMs: 5,
      listRunEvents: tl.list,
      runTrackedTurn: async (_i, { onRunCreated }) => {
        onRunCreated("run4");
        tl.write("text", { kind: "thinking", step: 1, state: "started" }, { publish: false });
        tl.write("text", { kind: "thinking", step: 1, state: "ended" }, { publish: false });
        tl.write("text", { kind: "text_delta", step: 1, text: "Done." }, { publish: false });
        return { assistantText: "Done.", toolCalls: [], threadTitle: null, runId: "run4" };
      },
    }))
      events.push(e);
    assertAguiSequence(events);
    const thinking = events.filter((e) => e.type === EventType.CUSTOM && (e as { name: string }).name === MARKETR_CUSTOM_NAMES.thinking) as Array<{ value: { step: number; state: string } }>;
    assert.deepEqual(
      thinking.map((t) => t.value),
      [
        { step: 1, state: "started" },
        { step: 1, state: "ended" },
      ],
    );
    assert.ok(events.indexOf(thinking[1] as unknown as AguiEvent) < events.findIndex((e) => e.type === EventType.TEXT_MESSAGE_START), "thinking ends before the text starts");
  });

  it("a resumed stream on the replica that runs the worker uses the bus too and ends on the status", async () => {
    const tl = timeline("run5");
    tl.write("text", { kind: "text_delta", step: 1, text: "old " }, { publish: false }); // seq 0, already delivered
    let status = "running";
    const release = claimRunProducer("run5");
    setTimeout(() => {
      tl.write("text", { kind: "text_delta", step: 1, text: "new." });
      status = "succeeded";
      release();
    }, 20);
    const out: AguiEvent[] = [];
    const t0 = Date.now();
    for await (const e of resumeChatTurnAgui(
      { workspaceId: "ws", threadId: "th", agentRunId: "run5", aguiRunId: "agui1", afterSeq: 0 },
      { listRunEvents: tl.list, getRunStatus: async () => status, latestAssistantText: async () => "old new.", logSink: () => undefined, pollMs: 100 },
    ))
      out.push(e);
    assert.deepEqual(deltas(out), ["new."]);
    assert.equal(out[out.length - 1]!.type, EventType.RUN_FINISHED);
    assert.ok(Date.now() - t0 < 1_500, "the bus woke the tail; it did not sit out the 2 s status wait");
    assert.equal(runListenerCount("run5"), 0);
  });
});
