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

import { isRetryableLlmError, LlmProviderError } from "./errors";
import type { LlmGenerateOptions, LlmProvider } from "./types";

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

  async generate(prompt: string, opts?: LlmGenerateOptions): Promise<string> {
    try {
      return await this.primary.generate(prompt, opts);
    } catch (err) {
      if (opts?.signal?.aborted) throw err; // Stop is never a failover
      if (!isRetryableLlmError(err)) throw err; // 4xx / unknown: surface as is
      const e = err as LlmProviderError;
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
      try {
        return await this.fallback.generate(prompt, opts);
      } catch (fallbackErr) {
        if (opts?.signal?.aborted) throw fallbackErr;
        if (fallbackErr instanceof LlmProviderError) {
          // Keep the fallback's classification; name both failures.
          throw new LlmProviderError({
            provider: fallbackErr.provider,
            kind: fallbackErr.kind,
            status: fallbackErr.status,
            retryAfterMs: fallbackErr.retryAfterMs,
            detail: `${fallbackErr.message.replace(/^LLM request failed \[[^\]]+\]: /, "")} (after failover from "${event.primaryModel}": ${reason})`,
          });
        }
        throw fallbackErr;
      }
    }
  }
}
