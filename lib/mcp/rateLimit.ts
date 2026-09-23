// Marketr — MCP per-credential rate limiter (Phase C, W5).
//
// Per-key/per-client fixed windows, keyed by credential id (NOT by IP —
// T4: rotating keys must not multiply one key's budget, and one abuser must
// not burn another credential's budget). In-memory, single-instance by design
// (same documented stance as lib/api/rate-limit.ts); front with a shared
// store for replicas. Bounded map so the limiter can't be a memory vector.

const MAX_TRACKED = 10_000;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export const MCP_RATE_LIMIT = 60; // calls
export const MCP_RATE_WINDOW_MS = 60_000; // per minute
export const MCP_PREAUTH_RATE_LIMIT = 10; // DCR register + token endpoint, per IP

function check(key: string, limit: number, windowMs: number, now: number): { allowed: boolean; retryAfterMs: number } {
  let b = buckets.get(key);
  if (!b || now - b.windowStart >= windowMs) {
    b = { count: 0, windowStart: now };
    buckets.set(key, b);
    if (buckets.size > MAX_TRACKED) {
      const oldest = buckets.keys().next().value;
      if (oldest) buckets.delete(oldest);
    }
  }
  b.count += 1;
  if (b.count > limit) {
    return { allowed: false, retryAfterMs: b.windowStart + windowMs - now };
  }
  return { allowed: true, retryAfterMs: 0 };
}

/** Per-credential limit for /mcp calls. */
export function checkMcpRateLimit(credentialId: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
  return check(`mcp:${credentialId}`, MCP_RATE_LIMIT, MCP_RATE_WINDOW_MS, now);
}

/** Stricter pre-auth limit for DCR register and token endpoints, keyed by IP. */
export function checkPreAuthRateLimit(ip: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
  return check(`mcp-preauth:${ip}`, MCP_PREAUTH_RATE_LIMIT, MCP_RATE_WINDOW_MS, now);
}

/** Test seam: reset all buckets. */
export function resetMcpRateLimits(): void {
  buckets.clear();
}
