// Marketr — tiered API rate limiting (Phase A hardening, Fix 6).
//
// Single choke point: proxy.ts classifies every /api/* request into a tier
// and calls checkRateLimit(). Route handlers are NOT edited for limiting.
//
// Tiers (per spec):
//   auth  — /api/auth/* (except read-only session/csrf/providers): 10 req/min, keyed by IP
//   read  — GET/HEAD/OPTIONS: 120 req/min, keyed by user (IP fallback)
//   write — POST/PUT/PATCH/DELETE: 60 req/min, keyed by user (IP fallback)
//   ai    — LLM / skill-execution routes (see AI_ROUTE_PATTERNS): 20 req/min, keyed by user
//
// In-memory fixed windows, single-instance by design — same documented stance
// as lib/auth/rate-limit.ts (the login brute-force limiter, which is
// complementary: lockouts for credential abuse, this for API abuse).
// Front with a shared limiter (Redis etc.) if you run replicas.
// Bounded bucket map (oldest evicted past MAX_BUCKETS) so the limiter itself
// can't be used as a memory-exhaustion vector.

export type RateLimitTier = "auth" | "read" | "write" | "ai";

export const TIER_LIMITS: Record<RateLimitTier, { limit: number; windowMs: number }> = {
  auth: { limit: 10, windowMs: 60_000 },
  read: { limit: 120, windowMs: 60_000 },
  write: { limit: 60, windowMs: 60_000 },
  ai: { limit: 20, windowMs: 60_000 },
};

/** Auth sub-paths that are read-only metadata — they get the read tier. */
const AUTH_READ_PATHS = new Set([
  "/api/auth/session",
  "/api/auth/csrf",
  "/api/auth/providers",
]);

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

/** Best-effort client IP from proxy headers. */
export function clientIp(headers: Headers): string | null {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || null;
  return headers.get("x-real-ip")?.trim() || null;
}

/** Test hook: clear all limiter state for deterministic tests. */
export function __resetRateLimits(): void {
  buckets.clear();
}
