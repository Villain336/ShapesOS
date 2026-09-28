// Marketr — Phase 14: sensitive-argument redaction.
//
// proposedArgs on an approval must never carry raw secrets into the DB or
// the review UI. Redaction happens at proposal time (and again after any
// edit-before-approve).
//
// Fail-closed doctrine (Tico, 2026-09-28): redaction is for STORAGE and LOGS
// only. Execution REFUSES any args containing the "[redacted]" placeholder —
// the gate will not run a tool with placeholder values where a secret was.
// Non-sensitive values are stored FULL-LENGTH; truncation happens only in
// summary/log views (summarizeArgs, summarizeAction).

const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|auth|credential|private[_-]?key|ssn|card|cvv|session)/i;

/** The placeholder redactArgs writes for sensitive values. Never executed. */
export const REDACTED_PLACEHOLDER = "[redacted]";

function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED_PLACEHOLDER;
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v));
  if (value && typeof value === "object") {
    return redactArgs(value as Record<string, unknown>);
  }
  // Non-sensitive values are stored full-length — truncation is a
  // presentation concern (summarizeArgs / summarizeAction).
  return value;
}

/** Deep-redact an args object. Returns a JSON-safe copy. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = redactValue(k, v);
  return out;
}

/**
 * True when any value in the (possibly nested) structure is exactly the
 * redaction placeholder. The execution paths refuse such args fail-closed.
 */
export function containsRedactedPlaceholder(value: unknown): boolean {
  if (value === REDACTED_PLACEHOLDER) return true;
  if (Array.isArray(value)) return value.some(containsRedactedPlaceholder);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsRedactedPlaceholder);
  }
  return false;
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
