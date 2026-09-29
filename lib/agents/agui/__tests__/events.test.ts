// Marketr — Phase 16 slice 1: AG-UI event contract tests.
// Run: npx tsx --test lib/agents/agui/__tests__/events.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PROTOCOL_VERSION,
  EventType,
  AGUI_PROTOCOL_VERSION,
  MARKETR_EMITTED_KINDS,
  assertAguiSequence,
  isValidAguiEvent,
  withRunMeta,
  type AguiEvent,
} from "../events";

const META = { runId: "run_test", threadId: "thread_test", workspaceId: "ws_test" };

function validSequence(): AguiEvent[] {
  return [
    withRunMeta({ type: EventType.RUN_STARTED, threadId: "thread_test", runId: "run_test" }, META),
    withRunMeta({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }, META),
    withRunMeta({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hello " }, META),
    withRunMeta({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "world" }, META),
    withRunMeta({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" }, META),
    withRunMeta(
      { type: EventType.RUN_FINISHED, threadId: "thread_test", runId: "run_test", outcome: { type: "success" } },
      META,
    ),
  ];
}

describe("AG-UI protocol conformance", () => {
  it("mirrors protocol version 1.0 from the pinned package", () => {
    assert.equal(PROTOCOL_VERSION, "1.0");
    assert.equal(AGUI_PROTOCOL_VERSION, "1.0");
  });

  it("every event in a valid sequence validates against the official schema", () => {
    for (const e of validSequence()) {
      assert.equal(isValidAguiEvent(e), true, `invalid: ${e.type}`);
    }
  });

  it("rejects events missing required fields", () => {
    assert.equal(isValidAguiEvent({ type: "TEXT_MESSAGE_START" }), false); // no messageId
    assert.equal(isValidAguiEvent({ type: "TOOL_CALL_START" }), false); // no toolCallId
    assert.equal(isValidAguiEvent({ type: "RUN_STARTED" }), false); // no threadId/runId
    assert.equal(isValidAguiEvent({ type: "NOPE" }), false);
  });

  it("emitted-kinds list only contains real protocol event types", () => {
    for (const kind of MARKETR_EMITTED_KINDS) {
      assert.ok(Object.values(EventType).includes(kind), `unknown kind ${kind}`);
    }
  });

  it("withRunMeta correlates events without clobbering protocol fields", () => {
    const e = withRunMeta({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" }, META);
    assert.equal(e.threadId, "t");
    assert.equal(e.runId, "r");
    assert.deepEqual((e as { metadata?: { marketr?: unknown } }).metadata?.marketr, { runId: "run_test", threadId: "thread_test", workspaceId: "ws_test" });
  });
});

describe("assertAguiSequence ordering invariants", () => {
  it("accepts a well-formed run", () => {
    assert.doesNotThrow(() => assertAguiSequence(validSequence()));
  });

  it("requires RUN_STARTED first", () => {
    const bad = validSequence().slice(1);
    assert.throws(() => assertAguiSequence(bad), /RUN_STARTED/);
  });

  it("requires a terminal event last", () => {
    const bad = validSequence().slice(0, -1);
    assert.throws(() => assertAguiSequence(bad), /RUN_FINISHED|RUN_ERROR/);
  });

  it("rejects CONTENT before START", () => {
    const evts = validSequence();
    // Move first CONTENT ahead of START.
    const content = evts.splice(2, 1)[0];
    evts.splice(1, 0, content);
    assert.throws(() => assertAguiSequence(evts), /CONTENT/);
  });

  it("rejects a second START while a message is open", () => {
    const evts = validSequence();
    evts.splice(2, 0, { type: EventType.TEXT_MESSAGE_START, messageId: "m2" } as AguiEvent);
    assert.throws(() => assertAguiSequence(evts), /still open/);
  });

  it("rejects TOOL_CALL_ARGS for an unopened toolCallId", () => {
    const evts = validSequence();
    evts.splice(1, 0, { type: EventType.TOOL_CALL_ARGS, toolCallId: "ghost", delta: "{}" } as AguiEvent);
    assert.throws(() => assertAguiSequence(evts), /unopened/);
  });

  it("rejects a run closed with a tool call still open", () => {
    const evts = validSequence();
    evts.splice(-1, 0, { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "x" } as AguiEvent);
    assert.throws(() => assertAguiSequence(evts), /tool call/);
  });

  it("accepts RUN_ERROR as the terminal event", () => {
    const evts: AguiEvent[] = [
      withRunMeta({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" }, META),
      withRunMeta({ type: EventType.RUN_ERROR, threadId: "t", runId: "r", message: "boom" }, META),
    ];
    assert.doesNotThrow(() => assertAguiSequence(evts));
  });
});
