// Marketr — native Anthropic Messages API provider (Phase D, Direction B).
//
// This is a dedicated adapter, NOT an LLM_BASE_URL swap: Anthropic's API is
// the Messages API (system + messages + max_tokens), not OpenAI-style
// /chat/completions. Key comes from ANTHROPIC_API_KEY only.
// Security: the key lives in a private field and is never interpolated into
// errors, logs, or return values (see lib/llm/THREAT-MODEL-LLM.md T3).
// Phase 6: errors are classified LlmProviderError (lib/llm/errors.ts) so the
// router can fail over on 429 / 5xx / timeout / network and never on other
// 4xx. The SDK's own retry is bounded to ONE (it honours Retry-After) and the
// per-attempt timeout is 2 minutes, instead of the SDK defaults (2 retries ×
// 10 minutes), so a degraded vendor hands over to the failover promptly.
// NOTE: live path is implemented but untested from this sandbox — the sandbox
// has no Anthropic credentials and restricted egress. Exercise it on a real
// host with ANTHROPIC_API_KEY in .env before trusting it.

import Anthropic from "@anthropic-ai/sdk";
import { LlmProviderError, kindForStatus, type LlmErrorKind } from "./errors";
import type { LlmGenerateOptions, LlmProvider } from "./types";

export const ANTHROPIC_TIMEOUT_MS = 120_000;
export const ANTHROPIC_MAX_RETRIES = 1;

/** Map an SDK error to a classified, key-free LlmProviderError. */
export function classifyAnthropicError(err: unknown): LlmProviderError {
  const provider = "anthropic";
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmProviderError({ provider, kind: "timeout", detail: "Anthropic API timeout" });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmProviderError({ provider, kind: "network", detail: "Anthropic API connection error" });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : null;
    const kind: LlmErrorKind = status === null ? "server" : kindForStatus(status);
    return new LlmProviderError({
      provider,
      kind,
      status,
      detail: `Anthropic API error (HTTP ${status ?? "unknown"})`,
    });
  }
  // Unknown failure inside the SDK: report it sanitized; treat as network so a
  // configured failover still gets a chance (it is never a 4xx rejection).
  const msg = err instanceof Error ? err.message : "unknown error";
  return new LlmProviderError({ provider, kind: "network", detail: msg });
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly isLive = true;

  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    // Key is passed to the SDK only; never stored in a loggable form.
    this.client = new Anthropic({
      apiKey,
      timeout: ANTHROPIC_TIMEOUT_MS,
      maxRetries: ANTHROPIC_MAX_RETRIES,
    });
    this.model = model;
  }

  isConfigured(): boolean {
    // The SDK holds the key; this provider exists only when a key was given.
    return true;
  }

  getModel(): string {
    return this.model;
  }

  async generate(prompt: string, opts?: LlmGenerateOptions): Promise<string> {
    const maxTokens = opts?.maxTokens ?? 4096;
    let res: Anthropic.Messages.Message;
    try {
      res = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        },
        opts?.signal ? { signal: opts.signal } : undefined,
      );
    } catch (err) {
      // Phase 5: a stopped run surfaces as the abort, not a provider failure.
      if (opts?.signal?.aborted) throw opts.signal.reason ?? err;
      // Never include key material: provider, status and a sanitized cause.
      throw classifyAnthropicError(err);
    }

    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) {
      throw new LlmProviderError({
        provider: "anthropic",
        kind: "empty",
        detail:
          res.stop_reason === "max_tokens"
            ? "empty response: the output-token cap was reached before any text — raise maxTokens"
            : "LLM returned an empty response",
      });
    }
    return text;
  }
}
