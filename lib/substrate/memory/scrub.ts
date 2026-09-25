// Marketr — Growth Memory secret scrubbing (Phase 8 G3, spec §9.9).
//
// The memory write path scrubs secret-shaped values BEFORE persistence —
// credentials live in the vault, never in the graph, never in memory
// payloads, never in logs. Tested with adversarial fixtures in
// lib/substrate/memory/fixtures/adversarial.ts (battery asserts none of the
// planted secrets survive).

export interface ScrubResult {
  text: string;
  /** How many secret-shaped values were replaced. */
  redactions: number;
  /** The kinds that were found (for logging, never the values). */
  kinds: string[];
}

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  // Private keys (multiline)
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // OpenAI-style keys
  { kind: "openai_key", re: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}\b/g },
  // GitHub tokens
  { kind: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  // Generic bearer / token assignments
  { kind: "bearer_token", re: /\b[Bb]earer\s+[A-Za-z0-9\-._~+/=]{16,}\b/g },
  // AWS access key ids (+ secret usually nearby; the id alone is sensitive)
  { kind: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "aws_secret", re: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{32,}['"]?/gi },
  // Stripe keys
  { kind: "stripe_key", re: /\b(?:sk_live|sk_test|rk_live|rk_test|whsec)_[A-Za-z0-9]{16,}\b/g },
  // Slack / generic xox tokens
  { kind: "slack_token", re: /\bxox[abpras]-[A-Za-z0-9-]{10,}\b/g },
  // Google API keys
  { kind: "google_key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  // Labeled secrets: password=..., api_key: "...", client_secret=...
  {
    kind: "labeled_secret",
    re: /\b(?:password|passwd|pwd|api[_-]?key|api[_-]?secret|client[_-]?secret|consumer[_-]?secret|webhook[_-]?secret|db[_-]?password|token)\s*[:=]\s*['"]?([^'"\s,;}]{6,})['"]?/gi,
  },
  // Basic-auth / connection-string passwords: scheme://user:PASS@host
  { kind: "url_password", re: /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@/\s]{4,})(@)/gi },
  // JWT-shaped blobs (header.payload.signature)
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

/** Scrub secret-shaped values from free text. Idempotent. */
export function scrubSecrets(text: string): ScrubResult {
  let out = text;
  let redactions = 0;
  const kinds = new Set<string>();
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(out)) {
      re.lastIndex = 0;
      out = out.replace(re, (_m, ...groups) => {
        // Keep the label / scheme context, redact only the value.
        if (kind === "labeled_secret" && groups[0]) return _m.replace(groups[0], "[REDACTED]");
        if (kind === "url_password") return `${groups[0]}[REDACTED]${groups[2]}`;
        return `[REDACTED:${kind}]`;
      });
      const count = (text.match(re) ?? []).length;
      redactions += count;
      kinds.add(kind);
    }
  }
  return { text: out, redactions, kinds: [...kinds] };
}

/**
 * Scrub every string inside a JSON-able value (used for object / metric_delta
 * / context_refs / refs payloads). Returns the scrubbed value.
 */
export function scrubJson<T>(value: T): { value: T; redactions: number; kinds: string[] } {
  let redactions = 0;
  const kinds = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = scrubSecrets(v);
      redactions += r.redactions;
      for (const k of r.kinds) kinds.add(k);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return { value: walk(value) as T, redactions, kinds: [...kinds] };
}
