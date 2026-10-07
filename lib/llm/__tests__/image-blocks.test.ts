// Phase 19A (WS=server): image blocks in a user turn (the agentic cursor's
// screenshots) reach both adapters in their native shape, in order, and an
// image in an assistant turn is dropped (with a note), never sent.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAnthropicParams } from "../anthropic";
import { buildResponsesBody } from "../openai";
import { FAMILY_WORKLOAD_DEFAULTS } from "../router";
import type { ChatRequest } from "../types";

const ANTHROPIC_MODEL = FAMILY_WORKLOAD_DEFAULTS.anthropic.subagent;
const OPENAI_MODEL = FAMILY_WORKLOAD_DEFAULTS.openai.subagent;

function req(): ChatRequest {
  return {
    maxTokens: 256,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Screen 1:" },
          { type: "image", mediaType: "image/jpeg", data: "QUJD" },
          { type: "text", text: "Where do I click?" },
        ],
      },
    ],
  };
}

describe("ChatImageBlock", () => {
  it("Anthropic: a base64 image block between the texts", () => {
    const built = buildAnthropicParams(ANTHROPIC_MODEL, req(), { stream: false }) as unknown as {
      params: { messages: Array<{ content: Array<Record<string, unknown>> }> };
    };
    const blocks = built.params.messages[0]!.content;
    assert.deepEqual(blocks.map((b) => b.type), ["text", "image", "text"]);
    assert.deepEqual(blocks[1], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } });
  });

  it("OpenAI Responses: input_text / input_image parts in order", () => {
    const { body } = buildResponsesBody(OPENAI_MODEL, req(), { selfHost: false, stream: false });
    const input = body.input as Array<{ role: string; content: unknown }>;
    assert.equal(input.length, 1);
    assert.deepEqual(input[0]!.content, [
      { type: "input_text", text: "Screen 1:" },
      { type: "input_image", image_url: "data:image/jpeg;base64,QUJD" },
      { type: "input_text", text: "Where do I click?" },
    ]);
  });

  it("OpenAI: a text-only message stays a plain string", () => {
    const { body } = buildResponsesBody(OPENAI_MODEL, { maxTokens: 16, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, { selfHost: false, stream: false });
    assert.equal((body.input as Array<{ content: unknown }>)[0]!.content, "hi");
  });

  it("OpenAI: an image in an assistant turn is dropped with a note", () => {
    const r: ChatRequest = {
      maxTokens: 16,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "image", mediaType: "image/png", data: "QUJD" }, { type: "text", text: "ok" }] },
      ],
    };
    const { body, notes } = buildResponsesBody(OPENAI_MODEL, r, { selfHost: false, stream: false });
    assert.equal(JSON.stringify(body.input).includes("input_image"), false);
    assert.ok(notes.some((n) => /dropped/.test(n)));
  });
});
