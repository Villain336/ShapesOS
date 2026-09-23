// Marketr — native Anthropic Messages API provider (Phase D, Direction B).
//
// This is a dedicated adapter, NOT an LLM_BASE_URL swap: Anthropic's API is
// the Messages API (system + messages + max_tokens), not OpenAI-style
// /chat/completions. Key comes from ANTHROPIC_API_KEY only.
// Security: the key lives in a private field and is never interpolated into
// errors, logs, or return values (see lib/llm/THREAT-MODEL-LLM.md T3).
// NOTE: live path is implemented but untested from this sandbox — the sandbox
// has no Anthropic credentials and restricted egress. Exercise it on a real
// host with ANTHROPIC_API_KEY in .env before trusting it.

import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider } from "./types";

export class AnthropicLlmProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly isLive = true;

  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    // Key is passed to the SDK only; never stored in a loggable form.
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  isConfigured(): boolean {
    // The SDK holds the key; this provider exists only when a key was given.
    return true;
  }

  getModel(): string {
    return this.model;
  }

  async generate(prompt: string, opts?: { maxTokens?: number }): Promise<string> {
    const maxTokens = opts?.maxTokens ?? 4096;
    let res: Anthropic.Messages.Message;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
    } catch (err) {
      // Never include key material: report the provider and a sanitized cause.
      const cause =
        err instanceof Anthropic.APIError
          ? `Anthropic API error (HTTP ${err.status ?? "unknown"})`
          : err instanceof Error
            ? err.message.replace(/[A-Za-z0-9_\-]{20,}/g, "[redacted]")
            : "unknown error";
      throw new Error(`LLM request failed [anthropic]: ${cause}`);
    }

    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) {
      throw new Error("LLM returned an empty response [anthropic]");
    }
    return text;
  }
}
