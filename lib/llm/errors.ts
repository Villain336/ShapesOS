// ShapesOS — classified LLM provider errors (Phase 6).
//
// Every live adapter throws LlmProviderError so the router's failover and the
// adapters' own bounded retry can decide on one fact: is this error worth
// trying again? 429 / 5xx / timeout / network are; any other 4xx (bad
// request, auth, unknown model) is not — repeating it, or sending the same
// prompt to another vendor, cannot fix a request the API rejected.
//
// A caller's abort (Phase 5 Stop) is never wrapped: adapters rethrow the
// signal's reason, so a stopped run surfaces as the abort itself.
//
// Messages never carry key material (THREAT-MODEL-LLM.md T3): provider name,
// HTTP status and a whitelisted error code only — never the response body.

export type LlmErrorKind =
  | "rate_limit" // HTTP 429 (incl. flex "Resource Unavailable")
  | "server" // HTTP 5xx, or an unreadable 2xx body
  | "timeout" // our own request timeout fired
  | "network" // connection refused / reset / DNS
  | "client" // any other 4xx — not retryable
  | "empty" // 2xx with no text (e.g. token budget spent on reasoning)
  // Phase 7: a streamed tool input the SDK could not parse at all. The
  // tool_use block never completed, so there is no id to answer with an
  // error result: the caller re-issues the turn (capped). Never a failover.
  | "tool_input";

const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set(["rate_limit", "server", "timeout", "network"]);

export class LlmProviderError extends Error {
  readonly provider: string;
  readonly kind: LlmErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;
  /** Server-requested wait before retrying (Retry-After), when present. */
  readonly retryAfterMs: number | null;

  constructor(args: {
    provider: string;
    kind: LlmErrorKind;
    status?: number | null;
    detail: string;
    retryAfterMs?: number | null;
  }) {
    super(`LLM request failed [${args.provider}]: ${redactKeyMaterial(args.detail)}`);
    this.name = "LlmProviderError";
    this.provider = args.provider;
    this.kind = args.kind;
    this.status = args.status ?? null;
    this.retryable = RETRYABLE.has(args.kind);
    this.retryAfterMs = args.retryAfterMs ?? null;
  }
}

/** Classify an HTTP status. Only called for non-2xx responses. */
export function kindForStatus(status: number): LlmErrorKind {
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  // 408 Request Timeout is the server telling us it gave up waiting — retryable.
  if (status === 408) return "timeout";
  return "client";
}

/** True when a retry (same provider) or a failover (other family) may help. */
export function isRetryableLlmError(err: unknown): boolean {
  return err instanceof LlmProviderError && err.retryable;
}

/** Long opaque tokens (keys, bearer tokens) never reach a message. Plain
 *  lowercase snake_case words (API error codes such as
 *  "context_length_exceeded") are not key-shaped and are kept. */
export function redactKeyMaterial(s: string): string {
  return s.replace(/[A-Za-z0-9_\-]{20,}/g, (t) => (/^[a-z]+(_[a-z]+)*$/.test(t) ? t : "[redacted]"));
}

/**
 * Parse Retry-After / retry-after-ms into milliseconds. Accepts delta-seconds
 * or an HTTP-date (RFC 9110 §10.2.3). Returns null when absent/unparseable.
 */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | null {
  const ms = headers.get("retry-after-ms");
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.max(0, Math.round(Number(ms)));
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const v = raw.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.max(0, Math.round(Number(v) * 1000));
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}
