// Marketr — OpenAI-compatible LLM provider.
// Talks to {LLM_BASE_URL}/chat/completions, so any OpenAI-style endpoint
// (OpenAI, an OpenAI-compatible proxy, Ollama, vLLM, …) works unchanged.
// NOTE: live path is implemented but untested from this sandbox — the sandbox
// has no LLM credentials and restricted egress. It must be exercised on a
// real host with keys in .env before being trusted.

import type { LlmProvider } from "./types";

export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name = "openai-compatible";
  readonly isLive = true;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getModel(): string {
    return this.model;
  }

  async generate(prompt: string, opts?: { maxTokens?: number }): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(
        "LLM credentials are not configured. Set LLM_API_KEY (or OPENAI_API_KEY) and LLM_MODEL.",
      );
    }
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
    });

    if (!res.ok) {
      throw new Error(`LLM request failed: HTTP ${res.status}`);
    }

    const json: unknown = await res.json();
    const text = (
      json as { choices?: Array<{ message?: { content?: unknown } }> }
    )?.choices?.[0]?.message?.content;

    if (typeof text !== "string" || !text.trim()) {
      throw new Error("LLM returned an empty response");
    }
    return text.trim();
  }
}
