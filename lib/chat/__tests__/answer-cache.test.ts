// Phase 17: the answer-cache key reads the question and the workspace
// context block out of the first user message (the prompt-cache layout puts
// the context there), and leaves recalled episodes out of the key.
// Run: env -u DATABASE_URL npx tsx --test lib/chat/__tests__/answer-cache.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { answerCacheKey, splitFirstUserMessage } from "../answer-cache";
import { CONTEXT_CLOSE, CONTEXT_OPEN } from "../context-markers";
import { LAYER_HEADERS, UNTRUSTED_CLOSE } from "@/lib/intelligence/company/prompt-context";
import type { ChatMessage } from "@/lib/llm/types";

const SYSTEM = "You are the ShapesOS lead agent.";

function context(project: string, episodes?: string): string {
  return [CONTEXT_OPEN, "## PROJECT CONTEXT", project, episodes ? `${LAYER_HEADERS.episodes}\n${episodes}\n${UNTRUSTED_CLOSE}` : "", CONTEXT_CLOSE].filter(Boolean).join("\n");
}

function first(question: string, ctx?: string): ChatMessage[] {
  return [{ role: "user", content: [...(ctx ? [{ type: "text" as const, text: ctx }] : []), { type: "text" as const, text: question }] }];
}

const key = (messages: ChatMessage[]) => answerCacheKey({ workspaceId: "ws", projectId: "p", system: SYSTEM, messages });

describe("answer cache key with the context block in the first user message", () => {
  it("finds the question after the context block, and a repeat with different wording matches", () => {
    const a = key(first("What's my visibility score?", context("12 tracked keywords")));
    const b = key(first("what's my visibility score", context("12 tracked keywords")));
    assert.ok(a);
    assert.equal(a, b);
  });

  it("the data the answer stands on is in the key: a project-context change misses", () => {
    assert.notEqual(key(first("score?", context("12 tracked keywords"))), key(first("score?", context("13 tracked keywords"))));
  });

  it("recalled episodes are not in the key (asking records an episode the next ask recalls)", () => {
    assert.equal(
      key(first("score?", context("12 tracked keywords", "- asked about the score yesterday"))),
      key(first("score?", context("12 tracked keywords", "- asked about the score yesterday\n- asked again today"))),
    );
  });

  it("a plain-text first message still works; an attachment or a conversation never uses the cache", () => {
    assert.ok(key([{ role: "user", content: "score?" }]));
    assert.equal(key([{ role: "user", content: [{ type: "text", text: "score?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] } as unknown as ChatMessage]), null);
    assert.equal(key([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "score?" }]), null);
  });

  it("a message that is only the context block has no question", () => {
    assert.deepEqual(splitFirstUserMessage([{ type: "text", text: context("x") }]), { context: context("x"), question: "" });
    assert.equal(key(first("", context("x"))), null);
  });
});
