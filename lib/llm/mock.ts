// Marketr — mock LLM provider.
//
// Used automatically when no LLM credentials are configured (see ./index).
// Returns a fixed, clearly-marked sample draft so the full brief → draft →
// edit → publish flow works end-to-end without a paid API key. The returned
// markdown is labeled at the top and the UI shows the provider banner, so it
// can never be mistaken for a real draft. Never ship it as real output.
//
// Phase 7: chat() / chatStream() are deterministic and scriptable for tests.
// Unscripted, chat() returns one clearly-labelled mock text block (no tool
// calls, zero usage, provider "mock"). With a script, each call consumes the
// next step: a partial ChatResponse, a function of the request, or an Error to
// throw (e.g. a retryable LlmProviderError to exercise failover). Scripted
// tool_use blocks pass the same tool-input checks as the live adapters.
// Mock calls are never metered — nothing was spent.

import { checkToolUse } from "./tool-input";
import type {
  ChatContentBlock,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  LlmGenerateOptions,
  LlmProvider,
} from "./types";

export type MockChatStep =
  | Partial<ChatResponse>
  | Error
  | ((req: ChatRequest, call: number) => Partial<ChatResponse> | Error | Promise<Partial<ChatResponse> | Error>);

export interface MockLlmOptions {
  /** Scripted chat() results, consumed in order; the last one repeats. */
  chatScript?: MockChatStep[];
}

export const MOCK_CHAT_TEXT =
  "> **Mock reply** — no LLM is configured for this workload, so no model was called. Set ANTHROPIC_API_KEY or OPENAI_API_KEY for real answers.";

export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";
  readonly isLive = false;
  /** Every chat()/chatStream() request, in order (test visibility). */
  readonly chatCalls: ChatRequest[] = [];
  private readonly script: MockChatStep[] | null;

  constructor(options: MockLlmOptions = {}) {
    this.script = options.chatScript && options.chatScript.length > 0 ? options.chatScript : null;
  }

  isConfigured(): boolean {
    return true;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const call = this.chatCalls.length;
    this.chatCalls.push(req);
    if (req.signal?.aborted) throw req.signal.reason;
    let step: Partial<ChatResponse> | Error = {};
    if (this.script) {
      const s = this.script[Math.min(call, this.script.length - 1)];
      step = typeof s === "function" ? await s(req, call) : s;
    }
    if (step instanceof Error) throw step;
    const stopReason = step.stopReason ?? (step.content?.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
    const content: ChatContentBlock[] = (step.content ?? [{ type: "text", text: MOCK_CHAT_TEXT }]).map((b) =>
      b.type === "tool_use" ? checkToolUse({ id: b.id, name: b.name, input: b.input }, req.tools, stopReason) : b,
    );
    return {
      id: step.id ?? null,
      content,
      stopReason,
      stopDetails: step.stopDetails ?? null,
      truncated: step.truncated ?? (stopReason === "max_tokens" || stopReason === "context_window_exceeded"),
      usage: step.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: step.model ?? "mock",
      provider: step.provider ?? this.name,
      costMicroUsd: step.costMicroUsd ?? 0,
      meta: step.meta ?? { serverToolsSent: [], notes: ["Mock provider: no model was called."] },
    };
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const res = await this.chat(req);
    for (const [index, b] of res.content.entries()) {
      if (b.type === "text") {
        // Deterministic chunks: one per word (keeps the separating spaces).
        for (const piece of b.text.match(/\S+\s*|\s+/g) ?? []) yield { type: "text_delta", index, text: piece };
      } else if (b.type === "tool_use") {
        yield { type: "tool_use_start", index, id: b.id, name: b.name };
        yield { type: "tool_input_delta", index, partialJson: JSON.stringify(b.input) };
        yield { type: "tool_use_stop", index, id: b.id, name: b.name, input: b.input, ...(b.invalid ? { invalid: b.invalid } : {}) };
      }
    }
    yield { type: "message_stop", stopReason: res.stopReason, usage: res.usage };
    yield { type: "final", response: res };
  }

  async generate(prompt: string, _opts?: LlmGenerateOptions): Promise<string> {
    // Pull the target keyword out of the prompt so the sample draft reads
    // plausibly. Everything else is fixed sample copy, clearly labeled.
    const m = prompt.match(/targeting the keyword:\s*"([^"]+)"/i);
    const keyword = m?.[1] ?? "your keyword";
    const titleCase = keyword.replace(/\b\w/g, (c) => c.toUpperCase());

    return [
      `> **Mock draft** — this placeholder was generated without an LLM.`,
      `> Set \`LLM_API_KEY\` (or \`OPENAI_API_KEY\`) and \`LLM_MODEL\` in \`.env\` for real AI drafts.`,
      ``,
      `# ${titleCase}: The Complete Guide`,
      ``,
      `If you're researching ${keyword}, you're in the right place. This guide covers what ${keyword} is, how much it costs, how to choose the right option, and the mistakes most people make along the way.`,
      ``,
      `## What Is ${titleCase}?`,
      ``,
      `${titleCase} is one of the most searched topics in its category for a reason: getting it right saves time and money, and getting it wrong is expensive. In this section we define the term plainly and explain who it's for.`,
      ``,
      `## How to Choose the Right Option`,
      ``,
      `Start with your budget, then compare the top-rated options on features that actually matter: reliability, support, and total cost of ownership. Avoid choosing on price alone — the cheapest option is rarely the best value.`,
      ``,
      `## Frequently Asked Questions`,
      ``,
      `**How much does ${keyword} cost?** Prices vary by provider and scope, so get at least three quotes before deciding.`,
      ``,
      `**Is ${keyword} worth it?** For most people, yes — provided you choose a reputable provider and understand what's included.`,
      ``,
      `## Next Steps`,
      ``,
      `Ready to move forward? Compare your top three options, check reviews, and book a consultation. (Replace this mock copy with a real draft by connecting an LLM provider.)`,
      ``,
    ].join("\n");
  }
}
