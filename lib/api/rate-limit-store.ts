// ShapesOS — shared counter store for the API rate limiter and the login
// lockout (Phase 6, infra).
//
// The limiters in lib/api/rate-limit.ts and lib/auth/rate-limit.ts keep their
// state in per-process Maps; behind several app replicas each replica counted
// on its own, so a client got N × the limit. This module adds one Postgres
// table (rate_limit_buckets, global, no RLS — see its migration) that every
// replica shares.
//
// Selection — RATE_LIMIT_STORE=memory|postgres:
//   * unset: postgres when DATABASE_URL is set and we run on Node; otherwise
//     memory (edge runtime, scripts and unit tests without a database).
//   * memory: always the in-process Maps (single-instance, the old behaviour).
//   * postgres: the shared table. Every call is bounded by a timeout.
// Failure policy lives with the callers:
//   * API rate limits FAIL OPEN to the in-memory limiter (a DB blip must not
//     take the whole API down; the per-process limit still applies).
//   * The login lockout NEVER fails open: it falls back to the in-memory
//     lockout, which is always written alongside the shared one.
//
// Times are epoch milliseconds supplied by the caller (Date.now() on the app
// replica), so tests can drive windows deterministically. Replicas are
// expected to be NTP-synced; the windows are minutes long.
//
// Prisma is imported lazily so the request proxy (proxy.ts) only loads it
// when the postgres store is actually selected.

export type RateLimitStoreKind = "memory" | "postgres";

export interface WindowHit {
  /** Hits in the current window, this one included. */
  count: number;
  /** Epoch ms the current window started. */
  windowStart: number;
}

export interface LockoutRecord {
  /** Failures in the current window. */
  failures: number;
  /** Epoch ms of the first failure in the current window. */
  firstAt: number;
  /** Epoch ms the lock ends (0 = not locked). */
  lockedUntil: number;
}

export interface LockoutPolicy {
  maxFailures: number;
  windowMs: number;
  baseLockoutMs: number;
  maxLockoutMs: number;
}

export interface CounterStore {
  readonly kind: "postgres" | "test";
  /** Atomic fixed-window check-and-increment. */
  hit(key: string, windowMs: number, now: number): Promise<WindowHit>;
  /** Atomic failure bump with the doubling, capped lockout of lib/auth/rate-limit.ts. */
  bumpLockout(key: string, policy: LockoutPolicy, now: number): Promise<LockoutRecord>;
  /** Current lockout records for these keys (missing keys are absent). */
  readLockouts(keys: string[]): Promise<Map<string, LockoutRecord>>;
  /** Forget these keys (successful sign-in). */
  clear(keys: string[]): Promise<void>;
  /** Delete rows whose window and lock are both over. Returns rows removed. */
  cleanup(now: number): Promise<number>;
}

/** Upper bound for one store call; past it the caller uses its fallback. */
export const STORE_TIMEOUT_MS = 1_000;
/** Opportunistic cleanup runs at most this often per process. */
export const CLEANUP_INTERVAL_MS = 5 * 60_000;

function isNodeRuntime(env: NodeJS.ProcessEnv): boolean {
  if (env.NEXT_RUNTIME === "edge") return false;
  return typeof process !== "undefined" && !!process.versions?.node;
}

let warnedUnknown = false;

/** Which store RATE_LIMIT_STORE (and the environment) selects. Pure apart from a one-time warning. */
export function rateLimitStoreKind(env: NodeJS.ProcessEnv = process.env): RateLimitStoreKind {
  if (!isNodeRuntime(env)) return "memory";
  const raw = (env.RATE_LIMIT_STORE ?? "").trim().toLowerCase();
  if (raw === "memory") return "memory";
  if (raw === "postgres") return "postgres";
  if (raw && !warnedUnknown) {
    warnedUnknown = true;
    console.warn(`[rate-limit] unknown RATE_LIMIT_STORE="${raw}" — expected memory|postgres; using the default`);
  }
  return env.DATABASE_URL?.trim() ? "postgres" : "memory";
}

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

type Raw = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
};

type Row = { count: number | bigint; window_start: number | bigint; locked_until: number | bigint | null };

const num = (v: number | bigint | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

export function postgresCounterStore(getDb?: () => Promise<Raw>): CounterStore {
  const db = getDb ?? (async () => (await import("../prisma")).prisma as unknown as Raw);
  return {
    kind: "postgres",

    async hit(key, windowMs, now) {
      const w = Math.max(1, Math.floor(windowMs));
      const n = Math.floor(now);
      // One statement: the ON CONFLICT row lock serialises concurrent hits on
      // a key, so the count is exact. A window that has run out restarts at n
      // (same "first hit opens the window" rule as the memory limiter).
      const rows = await (await db()).$queryRaw<Row[]>`
        INSERT INTO "rate_limit_buckets" AS cur ("key", "window_start", "count", "locked_until", "expires_at")
        VALUES (${key}, ${n}::bigint, 1, NULL, ${n}::bigint + ${w}::bigint)
        ON CONFLICT ("key") DO UPDATE SET
          "window_start" = CASE WHEN cur."window_start" <= ${n}::bigint - ${w}::bigint THEN ${n}::bigint ELSE cur."window_start" END,
          "count"        = CASE WHEN cur."window_start" <= ${n}::bigint - ${w}::bigint THEN 1 ELSE cur."count" + 1 END,
          "locked_until" = NULL,
          "expires_at"   = CASE WHEN cur."window_start" <= ${n}::bigint - ${w}::bigint THEN ${n}::bigint + ${w}::bigint
                                ELSE cur."window_start" + ${w}::bigint END
        RETURNING "count", "window_start", "locked_until"`;
      const r = rows[0];
      return { count: num(r?.count), windowStart: num(r?.window_start) };
    },

    async bumpLockout(key, policy, now) {
      const n = Math.floor(now);
      const w = Math.floor(policy.windowMs);
      const m = Math.max(1, Math.floor(policy.maxFailures));
      const base = Math.floor(policy.baseLockoutMs);
      const cap = Math.floor(policy.maxLockoutMs);
      // A row is relevant while its window runs or its lock holds; both end
      // by (last bump + max(window, cap)), so that is when it may be swept.
      const ttl = Math.max(w, cap);
      // Mirrors bump() in lib/auth/rate-limit.ts exactly:
      //   reset  = window over AND no live lock (a live lock is never reset)
      //   count  = reset ? 1 : count + 1
      //   lock   = count >= max ? now + min(base * 2^min(count - max, 16), cap)
      //                         : (reset ? none : unchanged)
      const rows = await (await db()).$queryRaw<Row[]>`
        INSERT INTO "rate_limit_buckets" AS cur ("key", "window_start", "count", "locked_until", "expires_at")
        VALUES (
          ${key}, ${n}::bigint, 1,
          CASE WHEN 1 >= ${m}::int THEN ${n}::bigint + LEAST(${base}::bigint, ${cap}::bigint) ELSE NULL END,
          ${n}::bigint + ${ttl}::bigint
        )
        ON CONFLICT ("key") DO UPDATE SET
          "window_start" = CASE
            WHEN cur."window_start" < ${n}::bigint - ${w}::bigint AND COALESCE(cur."locked_until", 0) <= ${n}::bigint
            THEN ${n}::bigint ELSE cur."window_start" END,
          "count" = CASE
            WHEN cur."window_start" < ${n}::bigint - ${w}::bigint AND COALESCE(cur."locked_until", 0) <= ${n}::bigint
            THEN 1 ELSE cur."count" + 1 END,
          "locked_until" = CASE
            WHEN (CASE WHEN cur."window_start" < ${n}::bigint - ${w}::bigint AND COALESCE(cur."locked_until", 0) <= ${n}::bigint
                       THEN 1 ELSE cur."count" + 1 END) >= ${m}::int
            THEN ${n}::bigint + LEAST(
              ${base}::bigint * (1::bigint << LEAST(GREATEST(
                (CASE WHEN cur."window_start" < ${n}::bigint - ${w}::bigint AND COALESCE(cur."locked_until", 0) <= ${n}::bigint
                      THEN 1 ELSE cur."count" + 1 END) - ${m}::int, 0), 16)),
              ${cap}::bigint)
            WHEN cur."window_start" < ${n}::bigint - ${w}::bigint AND COALESCE(cur."locked_until", 0) <= ${n}::bigint
            THEN NULL
            ELSE cur."locked_until" END,
          "expires_at" = ${n}::bigint + ${ttl}::bigint
        RETURNING "count", "window_start", "locked_until"`;
      const r = rows[0];
      return { failures: num(r?.count), firstAt: num(r?.window_start), lockedUntil: num(r?.locked_until) };
    },

    async readLockouts(keys) {
      const out = new Map<string, LockoutRecord>();
      if (keys.length === 0) return out;
      const rows = await (await db()).$queryRaw<Array<Row & { key: string }>>`
        SELECT "key", "count", "window_start", "locked_until"
          FROM "rate_limit_buckets" WHERE "key" = ANY(${keys}::text[])`;
      for (const r of rows) {
        out.set(r.key, { failures: num(r.count), firstAt: num(r.window_start), lockedUntil: num(r.locked_until) });
      }
      return out;
    },

    async clear(keys) {
      if (keys.length === 0) return;
      await (await db()).$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "key" = ANY(${keys}::text[])`;
    },

    async cleanup(now) {
      return (await db()).$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "expires_at" < ${Math.floor(now)}::bigint`;
    },
  };
}

// ---------------------------------------------------------------------------
// Active store + guards
// ---------------------------------------------------------------------------

let override: CounterStore | null | undefined;
let pgStore: CounterStore | null = null;
let lastCleanup = 0;

/** The shared store to use, or null when the in-memory limiter is selected. */
export function sharedCounterStore(env: NodeJS.ProcessEnv = process.env): CounterStore | null {
  if (override !== undefined) return override;
  if (rateLimitStoreKind(env) !== "postgres") return null;
  return (pgStore ??= postgresCounterStore());
}

/** Test hook: force a store (null = memory only); undefined restores env selection. */
export function __setCounterStoreForTests(store: CounterStore | null | undefined): void {
  override = store;
  lastCleanup = 0;
}

/** Reject after `ms` so a hung database can't stall a request. */
export function withStoreTimeout<T>(p: Promise<T>, ms: number = STORE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`rate-limit store timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Fire-and-forget sweep of expired rows, at most every CLEANUP_INTERVAL_MS per process. */
export function maybeCleanup(store: CounterStore, now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  void store.cleanup(now).catch((err) => storeWarn("cleanup", err));
}

let lastWarnAt = 0;
/** Log store failures, at most once a minute so an outage doesn't flood the log. */
export function storeWarn(op: string, err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[rate-limit] shared store ${op} failed, using the in-memory fallback: ${msg}`);
}
