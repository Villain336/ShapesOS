// Marketr — R4: per-token+IP rate limiter for the public review landing page.
// Mirrors lib/physical/bundles.ts checkRedeemRateLimit (10/min per code+IP).
// In-memory fixed windows, single-instance by design — same documented stance
// as lib/api/rate-limit.ts. The token is the capability; the limiter only
// blunts enumeration/brute-force against it.

import { clientIpFromHeaders } from "@/lib/api/client-ip";

const BUCKETS = new Map<string, { count: number; resetAt: number }>();
const LIMIT = 30;
const WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000;

export function checkReviewPageRateLimit(token: string, ip: string): boolean {
  const key = `${token.trim().slice(0, 64)}|${ip.trim().toLowerCase()}`;
  const now = Date.now();
  const cur = BUCKETS.get(key);
  if (!cur || now >= cur.resetAt) {
    if (BUCKETS.size >= MAX_BUCKETS) {
      const oldest = BUCKETS.keys().next().value;
      if (oldest) BUCKETS.delete(oldest);
    }
    BUCKETS.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (cur.count >= LIMIT) return false;
  cur.count += 1;
  return true;
}

/** Test hook. */
export function resetReviewPageRateLimits(): void {
  BUCKETS.clear();
}

export function clientIp(req: Request): string {
  return clientIpFromHeaders(req.headers) ?? "unknown";
}
