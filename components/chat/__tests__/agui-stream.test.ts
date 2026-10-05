// ShapesOS — Phase 8: the chat panel's AG-UI stream reader (PURE).
// Run: env -u DATABASE_URL npx tsx --test components/chat/__tests__/agui-stream.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emptyStreamingTurn, foldAguiEvent, readSseFrames, streamChatFrames, type AguiFrame } from "../agui-stream";

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

describe("chat stream across a server restart (deploy PR)", () => {
  const frame = (o: Record<string, unknown>, id?: string) => `${id ? `id: ${id}\n` : ""}data: ${JSON.stringify({ metadata: { marketr: { runId: "agui1" } }, ...o })}\n\n`;
  const sse = (s: string) => new Response(streamOf([s]));

  it("resumes on `reconnect` from the server's cursor, with Last-Event-ID", async () => {
    const calls: Array<{ url: string; last: string | null }> = [];
    const first = streamOf([
      "retry: 2000\n\n",
      frame({ type: "RUN_STARTED" }),
      frame({ type: "TEXT_MESSAGE_START", messageId: "m1" }, "run9:3"),
      frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hel" }, "run9:3"),
      `retry: 2000\n\nevent: reconnect\ndata: ${JSON.stringify({ runId: "run9", after: 3, aguiRunId: "agui1" })}\n\n`,
    ]);
    const out: AguiFrame[] = [];
    for await (const f of streamChatFrames(first, {
      fetchResume: async (url, last) => {
        calls.push({ url, last });
        return sse(frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "lo" }, "run9:4") + frame({ type: "RUN_FINISHED" }, "run9:4"));
      },
      sleep: async () => undefined,
    })) out.push(f);
    assert.deepEqual(calls, [{ url: "/api/agents/chat/stream?runId=run9&aguiRunId=agui1&after=3", last: "run9:3" }]);
    let t = emptyStreamingTurn();
    for (const f of out) t = foldAguiEvent(t, f);
    assert.deepEqual(t.messages, [{ id: "m1", text: "Hello" }], "the same message continues across replicas");
    assert.equal(t.done, true);
  });

  it("a stream cut without a goodbye resumes from the last id it saw", async () => {
    const calls: string[] = [];
    const cut = streamOf([frame({ type: "RUN_STARTED" }), frame({ type: "TOOL_CALL_START", toolCallName: "x" }, "run2:8")]);
    const out: string[] = [];
    for await (const f of streamChatFrames(cut, {
      fetchResume: async (url) => (calls.push(url), sse(frame({ type: "RUN_FINISHED" }, "run2:9"))),
      sleep: async () => undefined,
    })) out.push(f.type);
    assert.deepEqual(calls, ["/api/agents/chat/stream?runId=run2&aguiRunId=agui1&after=8"]);
    assert.deepEqual(out, ["RUN_STARTED", "TOOL_CALL_START", "RUN_FINISHED"]);
  });

  it("stops on RUN_FINISHED / RUN_ERROR, on 404, and after maxResumes failures", async () => {
    let n = 0;
    for await (const _ of streamChatFrames(streamOf([frame({ type: "RUN_ERROR", message: "x" }, "r:1")]), { fetchResume: async () => (n++, sse("")) })) void _;
    assert.equal(n, 0, "a finished turn never resumes");
    for await (const _ of streamChatFrames(streamOf([frame({ type: "RUN_STARTED" }, "r:1")]), { fetchResume: async () => (n++, new Response("", { status: 404 })) })) void _;
    assert.equal(n, 1, "404: the run is not ours / gone");
    n = 0;
    for await (const _ of streamChatFrames(streamOf([frame({ type: "RUN_STARTED" }, "r:1")]), {
      fetchResume: async () => (n++, new Response("busy", { status: 503 })),
      sleep: async () => undefined,
      maxResumes: 3,
    })) void _;
    assert.equal(n, 3);
  });
});
