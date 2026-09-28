// Marketr — Phase 14: sensitive-argument redaction.
//
// proposedArgs on an approval must never carry raw secrets into the DB or
// the review UI. Redaction happens at proposal time (and again after any
// edit-before-approve).

const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|auth|credential|private[_-]?key|ssn|card|cvv|session)/i;
const MAX_STR = 500;

function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return value.length > MAX_STR ? value.slice(0, MAX_STR) + "…" : value;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v));
  if (value && typeof value === "object") {
    return redactArgs(value as Record<string, unknown>);
  }
  return value;
}

/** Deep-redact an args object. Returns a JSON-safe copy. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = redactValue(k, v);
  return out;
}

/** A compact, still-redacted summary for ComposioActionLog.argsSummary. */
export function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactArgs(args);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(redacted)) {
    out[k] =
      typeof v === "string" && v.length > 120 ? v.slice(0, 120) + "…" : v;
  }
  return out;
}
