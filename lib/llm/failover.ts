// ShapesOS — provider failover (Phase 6).
//
// Wraps a workload's primary provider with the other family's allowed model
// for the same workload. The router builds it only when that family's key is
// configured and the fallback model passes the same ZDR allow-list and
// block-list as any primary (lib/llm/router.ts) — a blocked model is never a
// fallback.
//
// Failover happens ONLY when the primary failed with a retryable error
// (429 / 5xx / timeout / network — LlmProviderError.retryable, after the
// adapter's own bounded retry). Never on:
//   - the caller's abort (Phase 5 Stop) — the abort propagates as is;
//   - any other 4xx — the other vendor can't fix a rejected request, and
//     re-sending client data to a second vendor for nothing is a T1 concern;
//   - non-LlmProviderError failures (programming errors).
// Every failover is logged with the workload, both models and the reason
// (never key material), and the last one is kept for status/ops.
//
// Phase 7: chat() follows the same rules. chatStream() fails over only while
// nothing has been yielded yet (the usual case: a 429 / 5xx / connection
// failure arrives before the first event); once events have reached the
// caller, a failure surfaces as is — replaying the turn on another model
// would duplicate output the caller already showed.

import { isRetryableLlmError, LlmProviderError } from "./errors";
import type { ChatRequest, ChatResponse, ChatStreamEvent, LlmGenerateOptions, LlmProvider } from "./types";

export interface FailoverEvent {
  workload: string;
  primaryModel: string;
  fallbackModel: string;
  /** e.g. "rate_limit (HTTP 429)" — never key material. */
  reason: string;
  at: string;
}

/** Last failover per workload (process-local; for ops visibility). */
const lastFailovers = new Map<string, FailoverEvent>();

export function lastFailover(workload: string): FailoverEvent | null {
  return lastFailovers.get(workload) ?? null;
}

/** Test seam. */
export function __resetFailoverLog(): void {
  lastFailovers.clear();
}

export class FailoverLlmProvider implements LlmProvider {
  /** Reports as the primary: callers and the status surface key off it. */
  readonly name: string;
  readonly isLive: boolean;

  constructor(
    readonly primary: LlmProvider,
    readonly fallback: LlmProvider,
    private readonly meta: {
      workload: string;
      primaryModel: string;
      fallbackModel: string;
      log?: (msg: string) => void;
    },
  ) {
    this.name = primary.name;
    this.isLive = primary.isLive;
  }

  isConfigured(): boolean {
    return this.primary.isConfigured();
  }

  get fallbackModel(): string {
    return this.meta.fallbackModel;
  }

  /**
   * Phase 17 (A2): the primary's answer. Nothing is lost on a failover: a
   * fallback without tool search ignores ChatToolDef.deferLoading and sends
   * every tool loaded (more tokens on that one call, the same tools).
   */
  supportsToolSearch(): boolean {
    return this.primary.supportsToolSearch?.() ?? false;
  }

  /** Log + remember a failover; returns the human reason. */
  private noteFailover(e: LlmProviderError): string {
    const reason = `${e.kind}${e.status ? ` (HTTP ${e.status})` : ""}`;
    const event: FailoverEvent = {
      workload: this.meta.workload,
      primaryModel: this.meta.primaryModel,
      fallbackModel: this.meta.fallbackModel,
      reason,
      at: new Date().toISOString(),
    };
    lastFailovers.set(this.meta.workload, event);
    (this.meta.log ?? console.warn)(
      `[llm-router] workload=${event.workload} model="${event.primaryModel}" failed: ${reason} → failing over to "${event.fallbackModel}"`,
    );
    return reason;
  }

  /** Keep the fallback's classification; name both failures. */
  private wrapFallbackError(fallbackErr: unknown, reason: string): unknown {
    if (fallbackErr instanceof LlmProviderError) {
      return new LlmProviderError({
        provider: fallbackErr.provider,
        kind: fallbackErr.kind,
        status: fallbackErr.status,
        retryAfterMs: fallbackErr.retryAfterMs,
        detail: `${fallbackErr.message.replace(/^LLM request failed \[[^\]]+\]: /, "")} (after failover from "${this.meta.primaryModel}": ${reason})`,
      });
    }
    return fallbackErr;
  }

  async generate(prompt: string, opts?: LlmGenerateOptions): Promise<string> {
    try {
      return await this.primary.generate(prompt, opts);
    } catch (err) {
      if (opts?.signal?.aborted) throw err; // Stop is never a failover
      if (!isRetryableLlmError(err)) throw err; // 4xx / unknown: surface as is
      const reason = this.noteFailover(err as LlmProviderError);
      try {
        return await this.fallback.generate(prompt, opts);
      } catch (fallbackErr) {
        if (opts?.signal?.aborted) throw fallbackErr;
        throw this.wrapFallbackError(fallbackErr, reason);
      }
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    try {
      return await this.primary.chat(req);
    } catch (err) {
      if (req.signal?.aborted) throw err; // Stop is never a failover
      if (!isRetryableLlmError(err)) throw err; // 4xx / unknown: surface as is
      const reason = this.noteFailover(err as LlmProviderError);
      try {
        const res = await this.fallback.chat(req);
        return withFailoverNote(res, this.meta.primaryModel, reason);
      } catch (fallbackErr) {
        if (req.signal?.aborted) throw fallbackErr;
        throw this.wrapFallbackError(fallbackErr, reason);
      }
    }
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    let yielded = false;
    let reason: string;
    try {
      for await (const ev of this.primary.chatStream(req)) {
        yielded = true;
        yield ev;
      }
      return;
    } catch (err) {
      if (yielded) throw err; // output already reached the caller
      if (req.signal?.aborted) throw err;
      if (!isRetryableLlmError(err)) throw err;
      reason = this.noteFailover(err as LlmProviderError);
    }
    try {
      for await (const ev of this.fallback.chatStream(req)) {
        yield ev.type === "final" ? { type: "final", response: withFailoverNote(ev.response, this.meta.primaryModel, reason) } : ev;
      }
    } catch (fallbackErr) {
      if (req.signal?.aborted) throw fallbackErr;
      throw this.wrapFallbackError(fallbackErr, reason);
    }
  }
}

function withFailoverNote(res: ChatResponse, primaryModel: string, reason: string): ChatResponse {
  return {
    ...res,
    meta: { ...res.meta, notes: [`Served by ${res.model} after "${primaryModel}" failed (${reason}).`, ...res.meta.notes] },
  };
}
