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
//
// Phase 7: chat() / chatStream() use the OpenAI Responses API (POST
// {baseUrl}/responses) over fetch — no SDK dependency — as the failover path
// for agent workloads. Function tools are mapped both ways (ChatToolDef ⇄
// {type:"function"}; tool_use ⇄ function_call; tool_result ⇄
// function_call_output). `store: false` keeps responses off OpenAI's servers.
// Anthropic server tools (web_search / web_fetch) are NOT sent; the response's
// meta.notes and meta.serverToolsSent say so. Reasoning items are not
// round-tripped (store:false without encrypted reasoning). Function-call
// arguments are strictly parsed and checked against the tool's schema
// (lib/llm/tool-input.ts) — the API does not validate non-strict tools.
// NOTE: the live path is exercised offline against a stub fetch only
// (lib/llm/__tests__/openai.test.ts, openai-chat.test.ts). The Responses API
// shapes follow OpenAI's docs as known on 2026-10-04 and are UNVERIFIED
// against the live API (and against vLLM/Ollama /v1/responses for
// self-host). Prove it on a real host with keys.

import { LlmProviderError, kindForStatus, parseRetryAfter } from "./errors";
import { estimateCostMicroUsd } from "./pricing";
import { checkToolUse } from "./tool-input";
import { assertModelSpendAllowed, recordChatUsage } from "./usage";
import type {
  ChatContentBlock,
  ChatEffort,
  ChatRequest,
  ChatResponse,
  ChatStopReason,
  ChatStreamEvent,
  ChatUsage,
  LlmGenerateOptions,
  LlmKeySource,
  LlmProvider,
} from "./types";

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
  /** Phase 7: router workload (metering label). */
  workload?: string | null;
  /** Phase 7: effort applied when a chat request names none. */
  defaultEffort?: ChatEffort | null;
  /** Phase 15: whose key this is (metering). Default "platform", or
   *  "self_host" when selfHost is set (a local model costs no credits). */
  keySource?: LlmKeySource;
}

/** Phase 15.2: token usage of a /chat/completions response (generate()).
 *  prompt_tokens includes the cached part; inputTokens is the uncached rest. */
export function mapChatCompletionsUsage(u: unknown): ChatUsage {
  const o = (u ?? {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  };
  const prompt = Math.max(0, Math.floor(o.prompt_tokens ?? 0));
  const cached = Math.min(Math.max(0, Math.floor(o.prompt_tokens_details?.cached_tokens ?? 0)), prompt);
  return {
    inputTokens: prompt - cached,
    outputTokens: Math.max(0, Math.floor(o.completion_tokens ?? 0)),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
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

// ── Responses API mapping (Phase 7) ─────────────────────────────────────────

export interface BuiltResponsesRequest {
  body: Record<string, unknown>;
  notes: string[];
}

/** Our effort → reasoning.effort. "max" has no documented equivalent → "high". */
function reasoningEffort(effort: ChatEffort, notes: string[]): string {
  if (effort === "max") {
    notes.push('Effort "max" is sent to OpenAI as reasoning effort "high".');
    return "high";
  }
  return effort;
}

function toolResultText(content: string | Array<{ text: string }>): string {
  return typeof content === "string" ? content : content.map((c) => c.text).join("\n");
}

/**
 * Build the Responses API body for one chat() turn. PURE (exported for tests).
 * Anthropic server tools and other providers' opaque blocks are never sent.
 */
export function buildResponsesBody(
  model: string,
  req: ChatRequest,
  opts: { selfHost: boolean; stream: boolean; defaultEffort?: ChatEffort | null },
): BuiltResponsesRequest {
  if (!Number.isInteger(req.maxTokens) || req.maxTokens < 1) {
    throw new LlmProviderError({ provider: "openai-compatible", kind: "client", detail: "maxTokens must be a positive integer" });
  }
  const notes: string[] = [];
  const { wireModel, serviceTier } = parseOpenAiModel(model, opts.selfHost);

  const instructions =
    typeof req.system === "string" ? req.system : (req.system ?? []).map((b) => b.text).join("\n\n");

  const input: Array<Record<string, unknown>> = [];
  let dropped = 0;
  for (const m of req.messages) {
    if (typeof m.content === "string") {
      input.push({ role: m.role, content: m.content });
      continue;
    }
    // Text runs become one message; tool calls / results become their own
    // items, in transcript order (a function_call_output must follow its call).
    let texts: string[] = [];
    // Phase 19A: images in a user turn make that message a content array
    // (input_text + input_image parts, in order); text-only stays a string.
    let images: Array<{ at: number; url: string }> = [];
    const flush = () => {
      if (texts.length === 0 && images.length === 0) return;
      if (images.length === 0) {
        input.push({ role: m.role, content: texts.join("\n\n") });
      } else {
        const parts: Array<Record<string, unknown>> = [];
        let ti = 0;
        for (const img of images) {
          while (ti < img.at) parts.push({ type: "input_text", text: texts[ti++] });
          parts.push({ type: "input_image", image_url: img.url });
        }
        while (ti < texts.length) parts.push({ type: "input_text", text: texts[ti++] });
        input.push({ role: m.role, content: parts });
      }
      texts = [];
      images = [];
    };
    for (const b of m.content) {
      switch (b.type) {
        case "text":
          texts.push(b.text);
          break;
        case "image":
          if (m.role !== "user") {
            dropped++;
            break;
          }
          images.push({ at: texts.length, url: `data:${b.mediaType};base64,${b.data}` });
          break;
        case "tool_use":
          flush();
          input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
          break;
        case "tool_result":
          flush();
          input.push({
            type: "function_call_output",
            call_id: b.toolUseId,
            output: b.isError ? `ERROR: ${toolResultText(b.content)}` : toolResultText(b.content),
          });
          break;
        case "opaque":
          dropped++; // thinking / server-tool blocks of another provider (or our own reasoning items)
          break;
      }
    }
    flush();
  }
  if (dropped) notes.push(`${dropped} provider-specific ${dropped === 1 ? "block" : "blocks"} (thinking, server tool results) could not be sent to OpenAI and were dropped.`);

  const body: Record<string, unknown> = {
    model: wireModel,
    input,
    max_output_tokens: req.maxTokens,
    // Zero-retention posture: never store responses on OpenAI's side.
    store: false,
  };
  if (instructions) body.instructions = instructions;

  const tools = [...(req.tools ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: t.strict === true,
    }));
    const tc = req.toolChoice;
    if (tc === "auto" || tc === "none") body.tool_choice = tc;
    else if (tc === "any") body.tool_choice = "required";
    else if (tc && typeof tc === "object") body.tool_choice = { type: "function", name: tc.name };
  }

  if (req.serverTools && req.serverTools.length > 0) {
    notes.push(`Server tools (${[...new Set(req.serverTools)].join(", ")}) run on Anthropic only; not sent to OpenAI.`);
  }
  if (req.cache || req.cacheConversation) {
    // OpenAI caches long prefixes automatically; nothing to send.
  }

  const effort = req.effort ?? opts.defaultEffort ?? undefined;
  if (!opts.selfHost && isReasoningModel(wireModel)) {
    if (effort) body.reasoning = { effort: reasoningEffort(effort, notes) };
    if (req.thinking === "off") notes.push("Reasoning cannot be turned off on OpenAI reasoning models; effort controls it.");
  } else if (effort || req.thinking) {
    notes.push(`Effort / thinking settings are not sent to ${wireModel}.`);
  }
  if (serviceTier) body.service_tier = serviceTier;
  if (opts.stream) body.stream = true;
  return { body, notes };
}

interface ResponsesOutputItem {
  type?: string;
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string; annotations?: unknown[] }>;
}

interface ResponsesJson {
  id?: string;
  status?: string;
  model?: string;
  incomplete_details?: { reason?: string } | null;
  output?: ResponsesOutputItem[];
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number } | null;
    output_tokens?: number;
  } | null;
}

export function mapResponsesUsage(u: ResponsesJson["usage"]): ChatUsage {
  const input = u?.input_tokens ?? 0;
  const cached = Math.min(u?.input_tokens_details?.cached_tokens ?? 0, input);
  // OpenAI reports cached tokens inside input_tokens; split them out so
  // inputTokens is the full-price remainder (same meaning as Anthropic's).
  return { inputTokens: input - cached, outputTokens: u?.output_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 };
}

/** Map a Responses API response object to a ChatResponse (exported for tests). */
export function mapResponsesOutput(
  json: ResponsesJson,
  ctx: { model: string; provider: string; req: ChatRequest; notes: string[] },
): ChatResponse {
  const content: ChatContentBlock[] = [];
  const calls: ResponsesOutputItem[] = [];
  let refusal: string | null = null;
  for (const item of json.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && typeof part.text === "string") {
          const cites = Array.isArray(part.annotations) && part.annotations.length > 0 ? part.annotations : undefined;
          content.push({ type: "text", text: part.text, ...(cites ? { citations: cites } : {}) });
        } else if (part.type === "refusal") {
          refusal = typeof part.refusal === "string" ? part.refusal : "";
        }
      }
    } else if (item.type === "function_call") {
      calls.push(item);
    }
    // reasoning items are not round-tripped (store:false, no encrypted content)
  }

  let stopReason: ChatStopReason;
  if (json.status === "incomplete") {
    const why = json.incomplete_details?.reason;
    stopReason = why === "max_output_tokens" ? "max_tokens" : why === "content_filter" ? "refusal" : "other";
  } else if (refusal !== null) {
    stopReason = "refusal";
  } else if (calls.length > 0) {
    stopReason = "tool_use";
  } else {
    stopReason = "end_turn";
  }

  for (const c of calls) {
    content.push(
      checkToolUse(
        { id: c.call_id ?? c.id ?? "", name: c.name ?? "", input: undefined, rawJson: c.arguments ?? "" },
        ctx.req.tools,
        stopReason,
      ),
    );
  }

  const usage = mapResponsesUsage(json.usage);
  return {
    id: json.id ?? null,
    content,
    stopReason,
    stopDetails: stopReason === "refusal" ? { category: null, explanation: refusal || json.incomplete_details?.reason || null } : null,
    truncated: stopReason === "max_tokens",
    usage,
    model: ctx.model,
    provider: ctx.provider,
    costMicroUsd: estimateCostMicroUsd(ctx.model, usage),
    meta: { serverToolsSent: [], notes: ctx.notes },
  };
}

/** Split an SSE byte stream into parsed `data:` JSON payloads. */
async function* sseEvents(body: ReadableStream<Uint8Array>, onChunk: () => void): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk();
      buf += decoder.decode(value, { stream: true });
      let sep: RegExpExecArray | null;
      while ((sep = /\r?\n\r?\n/.exec(buf))) {
        const raw = buf.slice(0, sep.index);
        buf = buf.slice(sep.index + sep[0].length);
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // a malformed event line is skipped; the terminal event decides
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface OpenConnection {
  res: Response;
  timedOut(): boolean;
  /** Restart the per-attempt timer (stream idle timeout). */
  touch(): void;
  done(): void;
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
  private readonly workload: string | null;
  private readonly defaultEffort: ChatEffort | null;
  /** Phase 15: "workspace" for a workspace's own key (0 credits). */
  readonly keySource: LlmKeySource;

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
    this.workload = options.workload ?? null;
    this.defaultEffort = options.defaultEffort ?? null;
    this.keySource = options.keySource ?? (this.selfHost ? "self_host" : "platform");
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

  getDefaultEffort(): ChatEffort | null {
    return this.defaultEffort;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new LlmProviderError({
        provider: this.name,
        kind: "client",
        detail: "credentials are not configured. Set LLM_API_KEY (or OPENAI_API_KEY).",
      });
    }
  }

  /** One bounded retry (honouring Retry-After) for retryable failures. */
  private async withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
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
        return await fn();
      } catch (err) {
        if (!(err instanceof LlmProviderError) || !err.retryable) throw err;
        lastErr = err;
      }
    }
    throw lastErr!;
  }

  /**
   * POST a JSON body and return the open response once the status is OK.
   * Every attempt has a timeout (a ref'd timer — AbortSignal.timeout's is
   * unref'd and would not keep a CLI/cron process alive while it waits); the
   * caller clears it with done() once the body is read.
   */
  private async open(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<OpenConnection> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
    const timeout = new AbortController();
    const fire = () => timeout.abort(new DOMException("LLM request timed out", "TimeoutError"));
    let timer = setTimeout(fire, this.timeoutMs);
    const done = () => clearTimeout(timer);
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(fire, this.timeoutMs);
    };
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      done();
      // Phase 5: a stopped run surfaces as the abort, not a provider failure.
      if (signal?.aborted) throw signal.reason ?? err;
      if (timeout.signal.aborted) {
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
      done();
      throw new LlmProviderError({
        provider: this.name,
        kind: kindForStatus(res.status),
        status: res.status,
        detail: `HTTP ${res.status}${code ? ` (${code})` : ""}`,
        retryAfterMs: parseRetryAfter(res.headers),
      });
    }
    return { res, timedOut: () => timeout.signal.aborted, touch, done };
  }

  private async readJson(conn: OpenConnection, signal?: AbortSignal): Promise<unknown> {
    try {
      return await conn.res.json();
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      throw new LlmProviderError({
        provider: this.name,
        kind: conn.timedOut() ? "timeout" : "server",
        status: conn.res.status,
        detail: conn.timedOut() ? "timed out reading the response" : "unreadable response body",
      });
    } finally {
      conn.done();
    }
  }

  async generate(prompt: string, opts?: LlmGenerateOptions): Promise<string> {
    this.assertConfigured();
    const signal = opts?.signal;
    // Phase 15.2: a capped workspace is refused before anything is sent.
    await assertModelSpendAllowed(opts?.usage, this.keySource, this.name);
    const body = buildChatCompletionsBody(this.model, prompt, opts?.maxTokens ?? DEFAULT_MAX_TOKENS, this.selfHost);
    return this.withRetry(async () => {
      const startedAt = Date.now();
      const conn = await this.open("/chat/completions", body, signal);
      const json = await this.readJson(conn, signal);
      // Phase 15.2: generate() is metered like chat(); tokens were spent even
      // when the text is empty, so record first (idempotent per response id).
      if (opts?.usage) {
        const j = json as { id?: unknown; usage?: unknown };
        const usage = mapChatCompletionsUsage(j?.usage);
        await recordChatUsage({
          context: opts.usage,
          workload: this.workload,
          provider: this.name,
          model: this.model,
          usage,
          costMicroUsd: estimateCostMicroUsd(this.model, usage),
          responseId: typeof j?.id === "string" ? j.id : null,
          keySource: this.keySource,
          // Phase 17 (A1): timing on every recorded call.
          timing: { ttftMs: null, durationMs: Date.now() - startedAt },
          effort: null,
          serviceTier: null,
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
          status: conn.res.status,
          detail:
            choice?.finish_reason === "length"
              ? "empty response: the output-token cap was spent before any text (reasoning models count reasoning tokens) — raise maxTokens"
              : "LLM returned an empty response",
        });
      }
      return text.trim();
    }, signal);
  }

  private failedResponse(json: Record<string, unknown>): LlmProviderError {
    const code = safeErrorCode(json?.response ?? json);
    return new LlmProviderError({
      provider: this.name,
      kind: "server",
      detail: `response failed${code ? ` (${code})` : ""}`,
    });
  }

  private async record(req: ChatRequest, res: ChatResponse): Promise<void> {
    await recordChatUsage({
      context: req.usage,
      workload: this.workload,
      provider: this.name,
      model: this.model,
      usage: res.usage,
      costMicroUsd: res.costMicroUsd,
      responseId: res.id,
      keySource: this.keySource,
      timing: res.timing ?? null,
      effort: res.effort ?? null,
      serviceTier: res.serviceTier ?? null,
    });
  }

  /** Phase 17 (A2): no server-side tool search on the Responses API — the loop's client-side search serves deferred tools. */
  supportsToolSearch(): boolean {
    return false;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.assertConfigured();
    await assertModelSpendAllowed(req.usage, this.keySource, this.name);
    const { body, notes } = buildResponsesBody(this.model, req, {
      selfHost: this.selfHost,
      stream: false,
      defaultEffort: this.defaultEffort,
    });
    const startedAt = Date.now();
    const json = (await this.withRetry(async () => {
      const conn = await this.open("/responses", body, req.signal);
      const j = (await this.readJson(conn, req.signal)) as Record<string, unknown>;
      if (j?.status === "failed") throw this.failedResponse(j);
      return j;
    }, req.signal)) as ResponsesJson;
    const res = mapResponsesOutput(json, { model: this.model, provider: this.name, req, notes });
    res.timing = { ttftMs: null, durationMs: Date.now() - startedAt };
    res.effort = req.effort ?? this.defaultEffort ?? null;
    await this.record(req, res);
    return res;
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    this.assertConfigured();
    await assertModelSpendAllowed(req.usage, this.keySource, this.name);
    const { body, notes } = buildResponsesBody(this.model, req, {
      selfHost: this.selfHost,
      stream: true,
      defaultEffort: this.defaultEffort,
    });
    // Retries cover connecting only; once events flow, a failure surfaces.
    const startedAt = Date.now();
    let firstDeltaAt: number | null = null;
    const conn = await this.withRetry(() => this.open("/responses", body, req.signal), req.signal);
    if (!conn.res.body) {
      conn.done();
      throw new LlmProviderError({ provider: this.name, kind: "server", detail: "streaming response had no body" });
    }
    const calls = new Map<number, { id: string; name: string }>();
    let terminal: ResponsesJson | null = null;
    try {
      try {
        for await (const ev of sseEvents(conn.res.body, conn.touch)) {
          const type = String(ev.type ?? "");
          const index = typeof ev.output_index === "number" ? ev.output_index : 0;
          // Phase 17 (A1): time to the first content delta of any kind.
          if (firstDeltaAt === null && type.endsWith(".delta")) firstDeltaAt = Date.now();
          if (type === "response.output_item.added") {
            const item = ev.item as ResponsesOutputItem | undefined;
            if (item?.type === "function_call") {
              const meta = { id: item.call_id ?? item.id ?? "", name: item.name ?? "" };
              calls.set(index, meta);
              yield { type: "tool_use_start", index, ...meta };
            }
          } else if (type === "response.output_text.delta") {
            if (typeof ev.delta === "string") yield { type: "text_delta", index, text: ev.delta };
          } else if (type === "response.function_call_arguments.delta") {
            if (typeof ev.delta === "string" && calls.has(index)) yield { type: "tool_input_delta", index, partialJson: ev.delta };
          } else if (type === "response.output_item.done") {
            const item = ev.item as ResponsesOutputItem | undefined;
            const meta = calls.get(index);
            if (item?.type === "function_call" && meta) {
              const checked = checkToolUse({ ...meta, input: undefined, rawJson: item.arguments ?? "" }, req.tools, null);
              yield {
                type: "tool_use_stop",
                index,
                id: meta.id,
                name: meta.name,
                input: checked.input,
                ...(checked.invalid ? { invalid: checked.invalid } : {}),
              };
            }
          } else if (type === "response.completed" || type === "response.incomplete") {
            terminal = (ev.response ?? {}) as ResponsesJson;
          } else if (type === "response.failed" || type === "error") {
            throw this.failedResponse(ev);
          }
        }
      } catch (err) {
        if (req.signal?.aborted) throw req.signal.reason ?? err;
        if (err instanceof LlmProviderError) throw err;
        throw new LlmProviderError({
          provider: this.name,
          kind: conn.timedOut() ? "timeout" : "network",
          detail: conn.timedOut() ? "stream went idle past the timeout" : "stream interrupted",
        });
      }
    } finally {
      conn.done();
    }
    if (!terminal) {
      throw new LlmProviderError({ provider: this.name, kind: "server", detail: "stream ended without a completed response" });
    }
    const res = mapResponsesOutput(terminal, { model: this.model, provider: this.name, req, notes });
    res.timing = { ttftMs: firstDeltaAt === null ? null : firstDeltaAt - startedAt, durationMs: Date.now() - startedAt };
    res.effort = req.effort ?? this.defaultEffort ?? null;
    await this.record(req, res);
    yield { type: "message_stop", stopReason: res.stopReason, usage: res.usage };
    yield { type: "final", response: res };
  }
}
