// ShapesOS — scrubbing for anything that leaves the process as telemetry
// (structured logs, Sentry events). Phase 4a observability.
//
// Two layers:
//   redactString  masks secret-shaped substrings inside free text (error
//                 messages, stack frames): credentials in URLs, bearer tokens,
//                 key=value secrets, JWTs, provider key prefixes, emails, and
//                 long opaque tokens.
//   redactFields  walks a structured value and replaces the VALUE of any key
//                 whose name says it holds a secret or PII (password, token,
//                 cookie, authorization, email, …), then runs redactString
//                 over every remaining string.
//
// Dependency-free so lib/api/errors.ts can use it without pulling anything in.

export const REDACTED = "[redacted]";

/** Key names whose values never leave the process. Matched case-insensitively. */
const SENSITIVE_KEY =
  /(pass(word|wd|phrase)?|secret|token|api[-_]?key|apikey|authorization|auth[-_]?header|cookie|set-cookie|session|credential|private[-_]?key|signature|cipher(text)?|encrypted|iv|auth[-_]?tag|refresh|bearer|dsn|^email$|^e-?mail[-_]?address$|^phone$|^ssn$|^card(number)?$)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

const STRING_RULES: Array<[RegExp, string]> = [
  // scheme://user:password@host → scheme://[redacted]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Authorization: Bearer xxx / Basic xxx
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED],
  // Well-known provider key prefixes (Stripe, OpenAI/Anthropic, GitHub, Slack, AWS, Google)
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}\b/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  [/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}\b/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, REDACTED],
  // key=value / key: value pairs whose key names a secret
  [
    /\b((?:password|passwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret|private[-_]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
    `$1${REDACTED}`,
  ],
  // Email addresses (PII)
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  // Long opaque tokens (hex ≥ 32, or base64url ≥ 40 with mixed case + digits)
  [/\b[a-f0-9]{32,}\b/gi, REDACTED],
  [/\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{40,}\b/g, REDACTED],
];

/** Mask secret-shaped substrings in free text. */
export function redactString(input: string, maxLength = 4000): string {
  let s = input.length > maxLength ? `${input.slice(0, maxLength)}…` : input;
  for (const [re, replacement] of STRING_RULES) s = s.replace(re, replacement);
  return s;
}

/**
 * Deep-copy `value` with sensitive keys masked and strings scrubbed. Errors
 * become { name, message, stack } (scrubbed); cycles and depth are bounded.
 */
export function redactFields(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (depth > 6) return "[truncated]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) return serializeError(value, depth, seen);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactFields(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redactFields(v, depth + 1, seen);
  }
  return out;
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: unknown;
}

export function serializeError(err: Error, depth = 0, seen = new WeakSet<object>()): SerializedError {
  const out: SerializedError = { name: err.name || "Error", message: redactString(err.message ?? "") };
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") out.code = String(code);
  if (err.stack) {
    // Frames only (the first line repeats the message, already scrubbed).
    const frames = err.stack.split("\n").slice(1, 16).map((l) => l.trim()).filter(Boolean);
    if (frames.length) out.stack = redactString(frames.join("\n"));
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && depth < 3) out.cause = redactFields(cause, depth + 1, seen);
  return out;
}
