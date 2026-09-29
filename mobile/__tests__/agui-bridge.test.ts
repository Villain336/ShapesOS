// Marketr mobile — unit tests for the AG-UI bridge pure functions.
// Mirrors the web shell's bridge contract (components/agents/agui-bridge.ts).
import { describe, expect, it } from "vitest";
import {
  MAX_BRIDGE_CONTENT,
  aguiMessageText,
  buildAguiChatBody,
  lastUserText,
  throwIfAguiChatError,
} from "../src/api/agui-bridge";

describe("aguiMessageText", () => {
  it("passes strings through", () => {
    expect(aguiMessageText("hello")).toBe("hello");
  });
  it("joins text parts", () => {
    expect(aguiMessageText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab");
  });
  it("skips binary parts", () => {
    expect(aguiMessageText([{ type: "binary", mimeType: "image/png" }])).toBe("");
  });
  it("handles null/undefined", () => {
    expect(aguiMessageText(null)).toBe("");
    expect(aguiMessageText(undefined)).toBe("");
  });
});

describe("lastUserText", () => {
  it("returns the newest user message text", () => {
    expect(
      lastUserText([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]),
    ).toBe("second");
  });
  it("returns empty when there is no user message", () => {
    expect(lastUserText([{ role: "assistant", content: "hi" }])).toBe("");
    expect(lastUserText(undefined)).toBe("");
  });
});

describe("buildAguiChatBody", () => {
  it("builds the route body shape { threadId, content }", () => {
    const body = buildAguiChatBody("t1", [{ role: "user", content: "do the thing" }]);
    expect(body).toEqual({ threadId: "t1", content: "do the thing" });
  });
  it("carries CoAgents state when present", () => {
    const body = buildAguiChatBody("t1", [{ role: "user", content: "x" }], { mission: { id: "m1" } });
    expect(body.state).toEqual({ mission: { id: "m1" } });
  });
  it("omits state when empty", () => {
    const body = buildAguiChatBody("t1", [{ role: "user", content: "x" }], {});
    expect("state" in body).toBe(false);
  });
  it("truncates to the route's 4000-char cap", () => {
    const body = buildAguiChatBody("t1", [{ role: "user", content: "y".repeat(9000) }]);
    expect(body.content.length).toBe(MAX_BRIDGE_CONTENT);
  });
  it("throws when there is no user message", () => {
    expect(() => buildAguiChatBody("t1", [])).toThrow(/no user message/);
    expect(() => buildAguiChatBody("t1", [{ role: "user", content: "   " }])).toThrow(/no user message/);
  });
});

describe("throwIfAguiChatError", () => {
  it("passes ok responses through untouched", async () => {
    const res = new Response("data: {}", { status: 200 });
    await expect(throwIfAguiChatError(res)).resolves.toBe(res);
  });
  it("throws with the route's error detail on failure", async () => {
    const res = new Response(JSON.stringify({ error: "Thread not found" }), { status: 404 });
    await expect(throwIfAguiChatError(res)).rejects.toThrow(/404.*Thread not found/);
  });
  it("throws a generic error on non-JSON failure bodies", async () => {
    const res = new Response("<html>bad gateway</html>", { status: 502 });
    await expect(throwIfAguiChatError(res)).rejects.toThrow(/502/);
  });
});
