// Marketr — OpenAI-compatible LLM provider.
// Talks to {baseUrl}/chat/completions, so any OpenAI-style endpoint
// (OpenAI, an OpenAI-compatible proxy, Ollama, vLLM, …) works unchanged.
//
// Phase 6 (reliability), checked against the OpenAI API docs on 2026-10-04:
//   - GPT-5 family / o-series are reasoning models: Chat Completions rejects a
//     non-default `temperature` (and top_p/logprobs) for them, so it is not
//     sent. The output cap is `max_completion_tokens` (`max_tokens` is
//     deprecated and rejected by reasoning models). Reasoning tokens count
//     against that cap, so an empty reply with finish_reason "length" is
//     reported as such instead of a generic "empty response".
//   - "gpt-5-nano:flex" is a ShapesOS routing alias, not a model name: the
//     request carries the base model with `service_tier: "flex"` and a longer
//     timeout (flex is slower; the docs show a 15-minute client timeout). A
//     flex 429 "Resource Unavailable" is not billed and is retryable.
//   - Self-host (LLM_SELF_HOST=1: vLLM, Ollama) keeps the classic shape —
//     `max_tokens` + `temperature` — and never strips a ":tag" suffix, since
//     Ollama model names use one (e.g. "qwen3:27b").
//   - Every request has a timeout; the caller's AbortSignal (Phase 5 Stop) is
//     honoured and surfaces as the abort itself, never as a provider failure.
//   - Errors are LlmProviderError (lib/llm/errors.ts): 429 / 5xx / timeout /
//     network are retryable, other 4xx are not. One bounded retry with
//     backoff runs here, honouring Retry-After; the router's failover runs
//     after that. Messages never contain the key or the response body.
// NOTE: the live path is exercised offline against a stub fetch only
// (lib/llm/__tests__/openai.test.ts). Prove it on a real host with keys.

import { LlmProviderError, kindForStatus, parseRetryAfter } from "./errors";
import type { LlmGenerateOptions, LlmProvider } from "./types";

export const OPENAI_DEFAULT_TIMEOUT_MS = 120_000;
/** Flex requests queue for capacity; the docs' examples use 15 minutes. */
export const OPENAI_FLEX_TIMEOUT_MS = 900_000;
/** Longest Retry-After we will sleep through before giving up on this
 *  provider (the router may then fail over instead of stalling a run). */
export const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_MAX_TOKENS = 4096;
const FLEX_SUFFIX = /:flex$/i;

export interface OpenAiCompatibleOptions {
  /** LLM_SELF_HOST=1: a local vLLM/Ollama endpoint, classic request shape. */
  selfHost?: boolean;
  /** Per-attempt request timeout. Defaults by tier (standard / flex). */
  timeoutMs?: number;
  /** Retries after the first attempt for retryable errors (default 1). */
  maxRetries?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Base backoff before the retry when no Retry-After is given. */
  backoffMs?: number;
}

/** GPT-5 family and o-series reasoning models (hosted OpenAI semantics). */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

/** Split a routing alias into the wire model and its service tier. */
export function parseOpenAiModel(
  model: string,
  selfHost: boolean,
): { wireModel: string; serviceTier: "flex" | null } {
  if (!selfHost && FLEX_SUFFIX.test(model)) {
    return { wireModel: model.replace(FLEX_SUFFIX, ""), serviceTier: "flex" };
  }
  return { wireModel: model, serviceTier: null };
}

/** The JSON body for one chat-completions request (exported for tests). */
export function buildChatCompletionsBody(
  model: string,
  prompt: string,
  maxTokens: number,
  selfHost: boolean,
): Record<string, unknown> {
  const { wireModel, serviceTier } = parseOpenAiModel(model, selfHost);
  const body: Record<string, unknown> = {
    model: wireModel,
    messages: [{ role: "user", content: prompt }],
  };
  if (selfHost) {
    // vLLM / Ollama: classic OpenAI shape, both fields accepted.
    body.max_tokens = maxTokens;
    body.temperature = 0.7;
  } else {
    body.max_completion_tokens = maxTokens;
    if (!isReasoningModel(wireModel)) body.temperature = 0.7;
  }
  if (serviceTier) body.service_tier = serviceTier;
  return body;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Only short machine codes from the error body are echoed (never text). */
function safeErrorCode(json: unknown): string | null {
  const e = (json as { error?: { code?: unknown; type?: unknown } } | null)?.error;
  for (const v of [e?.code, e?.type]) {
    if (typeof v === "string" && /^[a-z0-9_.]{1,64}$/i.test(v)) return v;
  }
  return null;
}

export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name = "openai-compatible";
  readonly isLive = true;
  private readonly selfHost: boolean;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly backoffMs: number;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
    options: OpenAiCompatibleOptions = {},
  ) {
    this.selfHost = options.selfHost ?? false;
    const { serviceTier } = parseOpenAiModel(model, this.selfHost);
    this.timeoutMs =
      options.timeoutMs ?? (serviceTier === "flex" ? OPENAI_FLEX_TIMEOUT_MS : OPENAI_DEFAULT_TIMEOUT_MS);
    this.maxRetries = Math.max(0, Math.min(options.maxRetries ?? 1, 1));
    this.fetchImpl = options.fetchImpl ?? ((...a) => fetch(...a));
    this.sleep = options.sleep ?? abortableSleep;
    this.backoffMs = options.backoffMs ?? 1_000;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getModel(): string {
    return this.model;
  }

  getTimeoutMs(): number {
    return this.timeoutMs;
  }

  async generate(prompt: string, opts?: LlmGenerateOptions): Promise<string> {
    if (!this.isConfigured()) {
      throw new LlmProviderError({
        provider: this.name,
        kind: "client",
        detail: "credentials are not configured. Set LLM_API_KEY (or OPENAI_API_KEY).",
      });
    }
    const signal = opts?.signal;
    let lastErr: LlmProviderError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0 && lastErr) {
        // Honour Retry-After; otherwise exponential backoff with jitter.
        const wait =
          lastErr.retryAfterMs ?? Math.round(this.backoffMs * 2 ** (attempt - 1) * (0.5 + Math.random() / 2));
        if (wait > MAX_RETRY_AFTER_MS) break; // too long — let the router fail over
        await this.sleep(wait, signal); // rejects with the abort reason on Stop
      }
      try {
        return await this.once(prompt, opts);
      } catch (err) {
        if (!(err instanceof LlmProviderError) || !err.retryable) throw err;
        lastErr = err;
      }
    }
    throw lastErr!;
  }

  private async once(prompt: string, opts?: LlmGenerateOptions): Promise<string> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body = buildChatCompletionsBody(
      this.model,
      prompt,
      opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      this.selfHost,
    );
    // A ref'd timer (AbortSignal.timeout's is unref'd and would not keep a
    // CLI/cron process alive while it waits), cleared once the body is read.
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException("LLM request timed out", "TimeoutError")),
      this.timeoutMs,
    );
    try {
      return await this.request(url, body, timeout.signal, opts);
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(
    url: string,
    body: Record<string, unknown>,
    timeout: AbortSignal,
    opts?: LlmGenerateOptions,
  ): Promise<string> {
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      // Phase 5: a stopped run surfaces as the abort, not a provider failure.
      if (opts?.signal?.aborted) throw opts.signal.reason ?? err;
      if (timeout.aborted) {
        throw new LlmProviderError({
          provider: this.name,
          kind: "timeout",
          detail: `no response within ${Math.round(this.timeoutMs / 1000)}s`,
        });
      }
      throw new LlmProviderError({
        provider: this.name,
        kind: "network",
        detail: `network error (${err instanceof Error ? err.name : "unknown"})`,
      });
    }

    if (!res.ok) {
      let code: string | null = null;
      try {
        code = safeErrorCode(await res.json());
      } catch {
        /* non-JSON error body — status alone is enough */
      }
      throw new LlmProviderError({
        provider: this.name,
        kind: kindForStatus(res.status),
        status: res.status,
        detail: `HTTP ${res.status}${code ? ` (${code})` : ""}`,
        retryAfterMs: parseRetryAfter(res.headers),
      });
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      if (opts?.signal?.aborted) throw opts.signal.reason ?? err;
      throw new LlmProviderError({
        provider: this.name,
        kind: timeout.aborted ? "timeout" : "server",
        status: res.status,
        detail: timeout.aborted ? "timed out reading the response" : "unreadable response body",
      });
    }
    const choice = (
      json as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> }
    )?.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new LlmProviderError({
        provider: this.name,
        kind: "empty",
        status: res.status,
        detail:
          choice?.finish_reason === "length"
            ? "empty response: the output-token cap was spent before any text (reasoning models count reasoning tokens) — raise maxTokens"
            : "LLM returned an empty response",
      });
    }
    return text.trim();
  }
}
