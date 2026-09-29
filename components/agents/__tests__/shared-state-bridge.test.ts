// Marketr — Phase 16 slice 4: bridge state-forwarding tests (pure).
// Run: npx tsx --test components/agents/__tests__/shared-state-bridge.test.ts
//
// Proves the UI→agent half at the bridge: CoAgents state from the
// RunAgentInput body is forwarded to /api/agents/chat; absent/empty state
// is omitted so the route body stays minimal.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAguiChatBody } from "../agui-bridge";

const MESSAGES = [{ role: "user", content: "hello agent" }];

describe("buildAguiChatBody with shared state", () => {
  it("forwards non-empty state to the backend", () => {
    const state = {
      calendar: { rows: [], updatedAt: "2026-09-29T10:00:00.000Z" },
      approvals: { pendingCount: 1, items: [], updatedAt: "2026-09-29T10:00:00.000Z" },
    };
    const body = buildAguiChatBody("thread1", MESSAGES, state);
    assert.equal(body.threadId, "thread1");
    assert.equal(body.content, "hello agent");
    assert.deepEqual(body.state, state);
  });

  it("omits state when absent (slice-2 behavior unchanged)", () => {
    const body = buildAguiChatBody("thread1", MESSAGES);
    assert.ok(!("state" in body));
  });

  it("omits state when empty", () => {
    const body = buildAguiChatBody("thread1", MESSAGES, {});
    assert.ok(!("state" in body));
  });
});
