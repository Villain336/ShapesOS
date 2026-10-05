// ShapesOS — Phase 8: server-side compaction on the Anthropic adapter (beta
// compact-2026-01-12 / compact_20260112), against a stubbed SDK client.
// Run: env -u DATABASE_URL npx tsx --test lib/llm/__tests__/anthropic-compaction.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicLlmProvider,
  buildAnthropicParams,
  COMPACTION_BETA,
  COMPACTION_EDIT,
  type AnthropicClientLike,
} from "../anthropic";
import type { ChatRequest } from "../types";

const REQ: ChatRequest = { messages: [{ role: "user", content: "hi" }], maxTokens: 100, compaction: true };

function message(content: unknown[]): Anthropic.Messages.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2 },
  } as unknown as Anthropic.Messages.Message;
}

describe("anthropic compaction", () => {
  it("Opus 5.5 gets the compaction beta and edit", () => {
    const b = buildAnthropicParams("claude-opus-5-5", REQ, { stream: false, betaAvailable: true });
    const p = b.params as unknown as Record<string, unknown>;
    assert.equal(b.compaction, true);
    assert.deepEqual(p.betas, [COMPACTION_BETA]);
    assert.deepEqual(p.context_management, { edits: [{ type: COMPACTION_EDIT }] });
  });

  it("models without it (Sonnet 5.5, Haiku) get nothing, and a note", () => {
    for (const model of ["claude-sonnet-5-5", "claude-haiku-4-5", "claude-fable-5-1"]) {
      const b = buildAnthropicParams(model, REQ, { stream: false, betaAvailable: true });
      assert.equal(b.compaction, false, model);
      assert.equal((b.params as unknown as Record<string, unknown>).context_management, undefined);
      assert.ok(b.notes.some((n) => /compaction is not available/.test(n)), model);
    }
  });

  it("not requested → not sent", () => {
    const b = buildAnthropicParams("claude-opus-5-5", { ...REQ, compaction: false }, { stream: false, betaAvailable: true });
    assert.equal(b.compaction, false);
    assert.equal(b.notes.length, 0);
  });

  it("chat() goes to the beta endpoint, passes compaction blocks back as opaque, and says so in meta", async () => {
    const calls: string[] = [];
    const client: AnthropicClientLike = {
      messages: {
        create: async () => {
          calls.push("messages");
          return message([{ type: "text", text: "plain" }]);
        },
        stream: () => {
          throw new Error("unused");
        },
      },
      beta: {
        messages: {
          create: async () => {
            calls.push("beta");
            return message([{ type: "compaction", content: "summary of earlier turns" }, { type: "text", text: "after compaction" }]);
          },
          stream: () => {
            throw new Error("unused");
          },
        },
      },
    };
    const p = new AnthropicLlmProvider("k", "claude-opus-5-5", { client });
    const res = await p.chat(REQ);
    assert.deepEqual(calls, ["beta"]);
    assert.equal(res.meta.compaction, "server");
    assert.equal(res.content[0]!.type, "opaque");
    assert.equal((res.content[0] as { kind: string }).kind, "compaction");
    // Without compaction the normal endpoint is used.
    await p.chat({ ...REQ, compaction: false });
    assert.deepEqual(calls, ["beta", "messages"]);
  });
});
