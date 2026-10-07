// Marketr — tiered API rate limiting (Phase A hardening, Fix 6).
//
// Single choke point: proxy.ts classifies every /api/* request into a tier
// and calls checkRateLimit(). Route handlers are NOT edited for limiting.
//
// Tiers (per spec):
//   auth  — /api/auth/* (except read-only session/csrf/providers): 10 req/min, keyed by IP
//   read  — GET/HEAD/OPTIONS: 120 req/min (RATE_LIMIT_READ_PER_MIN), keyed by user (IP fallback)
//   write — POST/PUT/PATCH/DELETE: 60 req/min, keyed by user (IP fallback)
//   ai    — LLM / skill-execution routes (see AI_ROUTE_PATTERNS): 20 req/min, keyed by user
//
// Two stores (Phase 6): checkRateLimitAsync() — what proxy.ts and the route
// handlers call — uses the shared Postgres table (lib/api/rate-limit-store.ts,
// RATE_LIMIT_STORE, default postgres when DATABASE_URL is set) so the limits
// hold across replicas, and FAILS OPEN to the in-memory limiter below when
// the database errors or is slow.
//
// Phase 17 (latency): which tier lives where, and why —
//   auth   SHARED (Postgres): credential abuse must be counted across
//          replicas, or N replicas give an attacker N × the attempts.
//   write  SHARED (Postgres): mutations and their side effects.
//   ai     SHARED (Postgres): every request here can spend model money.
//   read   PER PROCESS (memory): a throttle against scraping and runaway
//          polling, not a correctness or money boundary. Every GET used to
//          pay a Postgres round trip in the proxy before the route ran;
//          per-process it costs nothing. Behind N replicas a client gets at
//          most N × 120/min of reads — still bounded.
// LOCAL_TIERS is the single list; a tier moves to memory only with a
// reason written above. checkRateLimit() is that in-memory fixed
// window: per process, kept for the fallback, scripts and tests. The login
// brute-force limiter (lib/auth/rate-limit.ts) is complementary: lockouts for
// credential abuse, this for API abuse.
// Bounded bucket map (oldest evicted past MAX_BUCKETS) so the limiter itself
// can't be used as a memory-exhaustion vector.

import { clientIpFromHeaders } from "./client-ip";
import { maybeCleanup, sharedCounterStore, storeWarn, withStoreTimeout } from "./rate-limit-store";

export type RateLimitTier = "auth" | "read" | "write" | "ai";

export const DEFAULT_READ_LIMIT = 120;

/**
 * RATE_LIMIT_READ_PER_MIN (optional) raises or lowers the READ tier only —
 * e.g. many people behind one office IP before they sign in, or the e2e suite
 * (one user, machine speed). Clamped to 30–6000; anything else keeps the
 * default. The auth, write and ai tiers are never configurable here: they
 * guard credentials, side effects and spend.
 */
export function readLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RATE_LIMIT_READ_PER_MIN;
  if (!raw) return DEFAULT_READ_LIMIT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 30 && n <= 6000 ? n : DEFAULT_READ_LIMIT;
}

export const TIER_LIMITS: Record<RateLimitTier, { limit: number; windowMs: number }> = {
  auth: { limit: 10, windowMs: 60_000 },
  read: { limit: readLimitFromEnv(), windowMs: 60_000 },
  write: { limit: 60, windowMs: 60_000 },
  ai: { limit: 20, windowMs: 60_000 },
};

/** Auth sub-paths that are read-only metadata — they get the read tier. */
const AUTH_READ_PATHS = new Set([
  "/api/auth/session",
  "/api/auth/csrf",
  "/api/auth/providers",
]);

/** Phase 10 (portal): client-portal sign-in routes (auth tier, IP-keyed). */
const PORTAL_AUTH_PATHS = new Set(["/api/portal/login", "/api/portal/link"]);

/**
 * Routes that burn LLM / skill-execution budget. Matched against the concrete
 * request pathname (e.g. /api/workflows/abc123/run). Keep this list tight:
 * over-matching punishes ordinary writes, under-matching lets AI spend run
 * at the write tier.
 */
const AI_ROUTE_PATTERNS: RegExp[] = [
  /^\/api\/chat\//, // AI chat threads + messages (agent loop)
  /^\/api\/team\/chat$/, // per-project chat
  /^\/api\/content\/(brief|draft)$/, // AI content generation
  /^\/api\/programmatic\/generate$/, // AI page generation
  /^\/api\/autopilot\//, // scheduled fix-agent
  /^\/api\/workflows\/[^/]+\/run$/, // automation / skill execution
  /^\/api\/automations\/draft$/, // Phase 18.3: "Describe it" (the lead model drafts an automation)
  /^\/api\/(sites|websites)\/[^/]+\/assist$/, // IDE assist (LLM)
  /^\/api\/websites\/generate$/, // site generation (LLM)
  /^\/api\/ads\/creatives\/[^/]+\/regenerate$/, // AI creative regen
  /^\/api\/local\/grids\/[^/]+\/run$/, // local grid runs
];

/** Pure classifier: tier for a request path + method. Unit-tested. */
export function classifyTier(pathname: string, method: string): RateLimitTier {
  if (pathname.startsWith("/api/auth/")) {
    return AUTH_READ_PATHS.has(pathname) ? "read" : "auth";
  }
  // Phase 10 (portal): client-portal sign-in is a sign-in surface too.
  if (PORTAL_AUTH_PATHS.has(pathname)) return "auth";
  const m = method.toUpperCase();
  // Read tier is the GET/listing traffic — checked before the AI patterns so
  // that history/list GETs on AI-adjacent routes (chat threads, autopilot
  // runs) stay on the read budget; only mutating AI execution is ai-tier.
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "read";
  if (AI_ROUTE_PATTERNS.some((re) => re.test(pathname))) return "ai";
  return "write";
}

interface Bucket {
  count: number;
  windowStart: number;
}

const MAX_BUCKETS = 10_000;
const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  /** ms until the current window resets (0 when allowed). */
  retryAfterMs: number;
}

/** Fixed-window check-and-increment. Pure apart from the bounded bucket map. */
export function checkRateLimit(
  key: string,
  tier: RateLimitTier,
  now: number = Date.now(),
): RateLimitResult {
  const { limit, windowMs } = TIER_LIMITS[tier];
  let b = buckets.get(key);
  if (!b || now - b.windowStart >= windowMs) {
    b = { count: 0, windowStart: now };
  }
  if (b.count >= limit) {
    buckets.set(key, b);
    return { allowed: false, retryAfterMs: Math.max(0, b.windowStart + windowMs - now) };
  }
  b.count += 1;
  if (buckets.size >= MAX_BUCKETS && !buckets.has(key)) {
    const oldest = buckets.keys().next().value as string | undefined;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  buckets.set(key, b);
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Shared fixed-window check-and-increment (Phase 6). Uses the store that
 * RATE_LIMIT_STORE selects; any store error or timeout falls back to the
 * in-memory checkRateLimit() — fail open to per-process limiting, never to
 * no limiting at all.
 */
/** Phase 17: tiers counted per process (see the header for why only these). */
export const LOCAL_TIERS: ReadonlySet<RateLimitTier> = new Set<RateLimitTier>(["read"]);

export async function checkRateLimitAsync(
  key: string,
  tier: RateLimitTier,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const store = LOCAL_TIERS.has(tier) ? null : sharedCounterStore();
  if (!store) return checkRateLimit(key, tier, now);
  const { limit, windowMs } = TIER_LIMITS[tier];
  try {
    const hit = await withStoreTimeout(store.hit(key, windowMs, now));
    maybeCleanup(store, now);
    if (hit.count > limit) {
      return { allowed: false, retryAfterMs: Math.max(0, hit.windowStart + windowMs - now) };
    }
    return { allowed: true, retryAfterMs: 0 };
  } catch (err) {
    storeWarn("hit", err);
    return checkRateLimit(key, tier, now);
  }
}

/**
 * Bucket key. Auth tier is always IP-keyed (pre-auth by definition).
 * Other tiers prefer the user id so one abusive IP can't burn a shared
 * user's budget — falling back to IP when the caller is unauthenticated
 * (those requests 401 at the route layer anyway).
 */
export function rateLimitKey(
  tier: RateLimitTier,
  userId: string | null,
  ip: string | null,
): string {
  const who = tier === "auth" || !userId ? `ip:${ip ?? "no-ip"}` : `user:${userId}`;
  return `${tier}:${who}`;
}

/** 429 response with a Retry-After header. Runtime-agnostic (no next/server import). */
export function tooManyRequests(retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return Response.json(
    { error: "Rate limit exceeded. Please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}

/**
 * Client IP for rate-limit keys — the trusted-proxy hop, never the
 * client-written leftmost X-Forwarded-For entry (see lib/api/client-ip.ts).
 */
export function clientIp(headers: Headers): string | null {
  return clientIpFromHeaders(headers);
}

/** Test hook: clear all limiter state for deterministic tests. */
export function __resetRateLimits(): void {
  buckets.clear();
}
