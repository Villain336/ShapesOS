// Marketr — MCP per-credential rate limiter (Phase C, W5; G3 pluggable).
//
// Per-key/per-client fixed windows, keyed by credential id (NOT by IP —
// T4: rotating keys must not multiply one key's budget, and one abuser must
// not burn another credential's budget).
//
// Two backends behind the RateLimiter interface:
//   - InMemoryRateLimiter: single-box/self-host default. Bounded map (10k
//     entries, oldest evicted) so the limiter can't be a memory vector.
//     Single-instance by design (same documented stance as
//     lib/api/rate-limit.ts).
//   - PostgresRateLimiter: windowed counters in the mcp_rate_limits table,
//     incremented with a single atomic INSERT ... ON CONFLICT DO UPDATE so
//     concurrent instances serialize on the row and agree (T13).
//
// Selection: MCP_RATE_LIMITER=postgres|memory (default memory, preserving
// current behavior). HOSTED / MULTI-BOX DEPLOYMENTS MUST SET
// MCP_RATE_LIMITER=postgres — with the default, N instances grant N× the
// per-credential budget.

import { prisma } from "@/lib/prisma";

export const MCP_RATE_LIMIT = 60; // calls
export const MCP_RATE_WINDOW_MS = 60_000; // per minute
export const MCP_PREAUTH_RATE_LIMIT = 10; // DCR register + token endpoint, per IP

const MAX_TRACKED = 10_000;

export interface RateCheckResult {
  allowed: boolean;
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Atomically consume one unit from the bucket; false when the window is exhausted. */
  check(key: string, limit: number, windowMs: number, now?: number): Promise<RateCheckResult>;
}

/** Single-instance in-memory limiter (default). */
export class InMemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { count: number; windowStart: number }>();

  async check(key: string, limit: number, windowMs: number, now = Date.now()): Promise<RateCheckResult> {
    let b = this.buckets.get(key);
    if (!b || now - b.windowStart >= windowMs) {
      b = { count: 0, windowStart: now };
      this.buckets.set(key, b);
      if (this.buckets.size > MAX_TRACKED) {
        const oldest = this.buckets.keys().next().value;
        if (oldest) this.buckets.delete(oldest);
      }
    }
    b.count += 1;
    if (b.count > limit) {
      return { allowed: false, retryAfterMs: b.windowStart + windowMs - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Test seam: reset all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Distributed limiter backed by Postgres (T13).
 * The increment is ONE statement — concurrent instances block on the same
 * (bucket_key, window_start) row and each increment is counted exactly once.
 */
export class PostgresRateLimiter implements RateLimiter {
  private opCount = 0;

  async check(key: string, limit: number, windowMs: number, now = Date.now()): Promise<RateCheckResult> {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const rows = await prisma.$queryRaw<{ count: number; window_start: bigint }[]>`
      INSERT INTO "mcp_rate_limits" ("bucket_key", "window_start", "count", "updated_at")
      VALUES (${key}, ${windowStart}::bigint, 1, NOW())
      ON CONFLICT ("bucket_key", "window_start")
      DO UPDATE SET "count" = "mcp_rate_limits"."count" + 1, "updated_at" = NOW()
      RETURNING "count", "window_start"`;
    const row = rows[0];
    if (!row) throw new Error("rate limit increment returned no row");
    const count = Number(row.count);
    const ws = Number(row.window_start);
    // Opportunistic expiry cleanup (amortized; see cleanup()).
    this.opCount += 1;
    if (this.opCount % 128 === 0) {
      this.cleanup(windowMs, now).catch(() => {});
    }
    if (count > limit) {
      return { allowed: false, retryAfterMs: Math.max(0, ws + windowMs - now) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Delete expired windows. Returns the number of rows removed. */
  async cleanup(windowMs: number = MCP_RATE_WINDOW_MS, now: number = Date.now()): Promise<number> {
    const cutoff = now - windowMs;
    const deleted = await prisma.$executeRaw`
      DELETE FROM "mcp_rate_limits" WHERE "window_start" < ${cutoff}::bigint`;
    return Number(deleted);
  }
}

// ── Backend selection ──────────────────────────────────────────────────────

let cached: RateLimiter | null = null;
let cachedFor: string | null = null;

function backendName(): string {
  return (process.env.MCP_RATE_LIMITER ?? "memory").trim().toLowerCase();
}

/** The active limiter for this process (memoized per env value). */
export function getRateLimiter(): RateLimiter {
  const name = backendName();
  if (!cached || cachedFor !== name) {
    cached = name === "postgres" ? new PostgresRateLimiter() : new InMemoryRateLimiter();
    cachedFor = name;
  }
  return cached;
}

/** Test seam: override the active limiter (pass null/undefined to re-select from env). */
export function __setRateLimiterForTest(limiter: RateLimiter | null | undefined): void {
  cached = limiter ?? null;
  cachedFor = limiter ? backendName() : null;
}

/** Per-credential limit for /mcp calls. */
export function checkMcpRateLimit(credentialId: string, now = Date.now()): Promise<RateCheckResult> {
  return getRateLimiter().check(`mcp:${credentialId}`, MCP_RATE_LIMIT, MCP_RATE_WINDOW_MS, now);
}

/** Stricter pre-auth limit for DCR register and token endpoints, keyed by IP. */
export function checkPreAuthRateLimit(ip: string, now = Date.now()): Promise<RateCheckResult> {
  return getRateLimiter().check(`mcp-preauth:${ip}`, MCP_PREAUTH_RATE_LIMIT, MCP_RATE_WINDOW_MS, now);
}

/** Test seam: reset in-memory buckets (no-op for the postgres backend — tests use unique keys). */
export function resetMcpRateLimits(): void {
  const l = getRateLimiter();
  if (l instanceof InMemoryRateLimiter) l.reset();
}

/** Delete expired postgres windows (also used by tests). */
export function cleanupRateLimits(windowMs = MCP_RATE_WINDOW_MS, now = Date.now()): Promise<number> {
  const l = getRateLimiter();
  if (l instanceof PostgresRateLimiter) return l.cleanup(windowMs, now);
  return Promise.resolve(0);
}
