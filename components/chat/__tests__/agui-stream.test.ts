// ShapesOS — Phase 8: the chat panel's AG-UI stream reader (PURE).
// Run: env -u DATABASE_URL npx tsx --test components/chat/__tests__/agui-stream.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emptyStreamingTurn, foldAguiEvent, readSseFrames, type AguiFrame } from "../agui-stream";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe("agui stream reader", () => {
  it("parses frames split across chunks", async () => {
    const frames: AguiFrame[] = [];
    const a = `data: ${JSON.stringify({ type: "TEXT_MESSAGE_START", messageId: "m1" })}\n\n`;
    const b = `data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hel" })}\n\n`;
    for await (const f of readSseFrames(streamOf([a.slice(0, 7), a.slice(7) + b.slice(0, 10), b.slice(10), ": ping\n\n"]))) frames.push(f);
    assert.deepEqual(frames.map((f) => f.type), ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]);
  });

  it("folds text, tools, queued and errors into the live view", () => {
    let t = emptyStreamingTurn();
    t = foldAguiEvent(t, { type: "TEXT_MESSAGE_START", messageId: "m1" });
    t = foldAguiEvent(t, { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello " });
    t = foldAguiEvent(t, { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "world" });
    assert.deepEqual(t.messages, [{ id: "m1", text: "Hello world" }]);
    t = foldAguiEvent(t, { type: "TOOL_CALL_START", toolCallName: "get_keywords" });
    assert.equal(t.activeTool, "get_keywords");
    t = foldAguiEvent(t, { type: "TOOL_CALL_RESULT" });
    assert.equal(t.activeTool, null);
    t = foldAguiEvent(t, { type: "CUSTOM", name: "marketr.queued" });
    assert.equal(t.queued, true);
    t = foldAguiEvent(t, { type: "RUN_ERROR", message: "nope" });
    assert.equal(t.error, "nope");
    assert.equal(t.done, true);
  });
});
