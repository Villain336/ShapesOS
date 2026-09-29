// Marketr — Phase 16 slice 2: agui-bridge unit tests.
// Run: npx tsx --test components/agents/__tests__/agui-bridge.test.ts
//
// Pure-logic tests for the RunAgentInput → /api/agents/chat translation.
// fetch-dependent paths (ensureChatThread, throwIfAguiChatError) stub the
// global fetch so no network is touched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aguiMessageText,
  lastUserText,
  buildAguiChatBody,
  throwIfAguiChatError,
  ensureChatThread,
} from "../agui-bridge";

describe("aguiMessageText", () => {
  it("passes string content through", () => {
    assert.equal(aguiMessageText("hello"), "hello");
  });

  it("joins text parts and skips non-text parts", () => {
    assert.equal(
      aguiMessageText([
        { type: "text", text: "a" },
        { type: "binary", mimeType: "image/png" },
        { type: "text", text: "b" },
      ]),
      "ab",
    );
  });

  it("returns empty string for non-content", () => {
    assert.equal(aguiMessageText(undefined), "");
    assert.equal(aguiMessageText(null), "");
    assert.equal(aguiMessageText(42), "");
  });
});

describe("lastUserText", () => {
  it("picks the newest user message", () => {
    const messages = [
      { id: "1", role: "user", content: "first" },
      { id: "2", role: "assistant", content: "reply" },
      { id: "3", role: "user", content: [{ type: "text", text: "second" }] },
    ];
    assert.equal(lastUserText(messages), "second");
  });

  it("returns empty string when no user message exists", () => {
    assert.equal(lastUserText([{ role: "assistant", content: "x" }]), "");
    assert.equal(lastUserText(undefined), "");
    assert.equal(lastUserText([]), "");
  });
});

describe("buildAguiChatBody", () => {
  it("maps thread + last user message to the route body", () => {
    const body = buildAguiChatBody("t1", [{ role: "user", content: "do the thing" }]);
    assert.deepEqual(body, { threadId: "t1", content: "do the thing" });
  });

  it("caps content at 4000 chars", () => {
    const body = buildAguiChatBody("t1", [{ role: "user", content: "x".repeat(5000) }]);
    assert.equal(body.content.length, 4000);
  });

  it("throws on empty user content", () => {
    assert.throws(() => buildAguiChatBody("t1", [{ role: "assistant", content: "hi" }]), /no user message/);
  });
});

describe("throwIfAguiChatError", () => {
  it("returns ok responses untouched", async () => {
    const res = new Response("data: {}", { status: 200 });
    assert.equal(await throwIfAguiChatError(res), res);
  });

  it("throws with the route's error detail on failure", async () => {
    const res = new Response(JSON.stringify({ error: "Thread not found" }), { status: 404 });
    await assert.rejects(() => throwIfAguiChatError(res), /404.*Thread not found/);
  });

  it("handles non-JSON error bodies", async () => {
    const res = new Response("<html>oops</html>", { status: 500 });
    await assert.rejects(() => throwIfAguiChatError(res), /500/);
  });
});

describe("ensureChatThread", () => {
  const realFetch = globalThis.fetch;

  function stubFetch(handlers: Array<(url: string, init?: RequestInit) => Response | null>) {
    (globalThis as { fetch: unknown }).fetch = (async (url: unknown, init?: RequestInit) => {
      for (const h of handlers) {
        const r = h(String(url), init);
        if (r) return r;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  it("uses the given project id and returns the created thread id", async () => {
    stubFetch([
      (url, init) =>
        url === "/api/chat/threads" && init?.method === "POST"
          ? new Response(JSON.stringify({ thread: { id: "thread-9" } }), { status: 200 })
          : null,
    ]);
    try {
      assert.equal(await ensureChatThread("proj-1"), "thread-9");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("resolves the first project when none is given", async () => {
    const seen: string[] = [];
    stubFetch([
      (url) => {
        seen.push(url);
        if (url === "/api/projects")
          return new Response(JSON.stringify({ projects: [{ id: "proj-a" }, { id: "proj-b" }] }), { status: 200 });
        if (url === "/api/chat/threads")
          return new Response(JSON.stringify({ thread: { id: "thread-a" } }), { status: 200 });
        return null;
      },
    ]);
    try {
      assert.equal(await ensureChatThread(null), "thread-a");
      assert.deepEqual(seen, ["/api/projects", "/api/chat/threads"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns null when thread creation fails", async () => {
    stubFetch([
      (url) =>
        url === "/api/chat/threads" ? new Response(JSON.stringify({ error: "nope" }), { status: 403 }) : null,
    ]);
    try {
      assert.equal(await ensureChatThread("proj-1"), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
