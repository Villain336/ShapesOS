// ShapesOS — Phase 17 (latency): the optimistic turn (PURE helpers in
// agui-stream.ts) and the status line component rendered to static markup.
// Run: env -u DATABASE_URL npx tsx --test components/chat/__tests__/optimistic-turn.test.tsx

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { emptyStreamingTurn, foldAguiEvent, liveStatusLine, optimisticSend, reconcileLive, type TurnMessage } from "../agui-stream";
import { LiveStatusLine } from "../LiveStatusLine";

const row = (id: string, role: string, content: string): TurnMessage => ({ id, role, content, toolCalls: null, createdAt: "2026-10-06T00:00:00.000Z" });

describe("optimistic send", () => {
  it("shows the user's turn at once with a temporary id, without a request", () => {
    const { messages, optimisticId } = optimisticSend([row("m1", "assistant", "Hi")], "What should I do next?", { id: "tmp-1", now: () => 1_700_000_000_000 });
    assert.equal(optimisticId, "tmp-1");
    assert.deepEqual(
      messages.map((m) => [m.id, m.role, m.content]),
      [
        ["m1", "assistant", "Hi"],
        ["tmp-1", "user", "What should I do next?"],
      ],
    );
    assert.equal(messages[1]!.createdAt, new Date(1_700_000_000_000).toISOString());
  });

  it("the status line reads Sending before any frame, Working on the first frame, Thinking, then the tool", () => {
    assert.deepEqual(liveStatusLine(null, true), { label: "Sending", live: true });
    assert.equal(liveStatusLine(null, false), null, "nothing in flight: no line");
    let t = emptyStreamingTurn();
    assert.deepEqual(liveStatusLine(t, true), { label: "Sending", live: true });
    t = foldAguiEvent(t, { type: "RUN_STARTED" });
    assert.deepEqual(liveStatusLine(t, true), { label: "Working", live: true });
    t = foldAguiEvent(t, { type: "CUSTOM", name: "marketr.thinking", value: { step: 1, state: "started" } });
    assert.equal(t.thinking, true);
    assert.deepEqual(liveStatusLine(t, true), { label: "Thinking", live: true });
    t = foldAguiEvent(t, { type: "CUSTOM", name: "marketr.thinking", value: { step: 1, state: "ended" } });
    assert.equal(t.thinking, false);
    t = foldAguiEvent(t, { type: "TOOL_CALL_START", toolCallName: "get_keywords" });
    assert.deepEqual(liveStatusLine(t, true), { label: "Running get keywords", live: true });
    t = foldAguiEvent(t, { type: "TOOL_CALL_RESULT" });
    t = foldAguiEvent(t, { type: "TEXT_MESSAGE_START", messageId: "a" });
    t = foldAguiEvent(t, { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "Here" });
    assert.equal(liveStatusLine(t, true), null, "streaming text is its own feedback");
    t = foldAguiEvent(t, { type: "RUN_FINISHED" });
    assert.equal(liveStatusLine(t, true), null);
  });

  it("a thinking state is cleared by the first text and a tool; the cached label wins", () => {
    let t = foldAguiEvent(emptyStreamingTurn(), { type: "CUSTOM", name: "marketr.thinking", value: { state: "started" } });
    t = foldAguiEvent(t, { type: "TEXT_MESSAGE_START", messageId: "a" });
    assert.equal(t.thinking, false);
    t = foldAguiEvent(t, { type: "CUSTOM", name: "marketr.cached", value: { question: "q" } });
    assert.equal(t.cached, true);
    assert.deepEqual(liveStatusLine({ ...t, started: true }, true), { label: "Reusing a recent answer", live: true });
    const q = foldAguiEvent(foldAguiEvent(emptyStreamingTurn(), { type: "RUN_STARTED" }), { type: "CUSTOM", name: "marketr.queued" });
    assert.deepEqual(liveStatusLine(q, true), { label: "Working in the background", live: true });
  });

  it("reconcileLive replaces the previous live bubbles and keeps the optimistic user row", () => {
    const base = [row("m1", "assistant", "Hi"), row("tmp-1", "user", "Q")];
    let t = foldAguiEvent(emptyStreamingTurn(), { type: "TEXT_MESSAGE_START", messageId: "x" });
    t = foldAguiEvent(t, { type: "TEXT_MESSAGE_CONTENT", messageId: "x", delta: "Hel" });
    const first = reconcileLive(base, t, "2026-10-06T00:00:01.000Z");
    assert.deepEqual(first.map((m) => m.id), ["m1", "tmp-1", "live-x"]);
    t = foldAguiEvent(t, { type: "TEXT_MESSAGE_CONTENT", messageId: "x", delta: "lo" });
    const second = reconcileLive(first, t, "2026-10-06T00:00:01.000Z");
    assert.deepEqual(second.map((m) => [m.id, m.content]), [["m1", "Hi"], ["tmp-1", "Q"], ["live-x", "Hello"]]);
  });
});

describe("LiveStatusLine", () => {
  it("renders the running shape and the label, and nothing when idle", () => {
    const html = renderToStaticMarkup(createElement(LiveStatusLine, { status: { label: "Thinking", live: true } }));
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /<svg/);
    assert.match(html, /animate-status-pulse/, "the running circle pulses while live");
    assert.match(html, />Thinking</);
    assert.equal(renderToStaticMarkup(createElement(LiveStatusLine, { status: null })), "");
  });
});
