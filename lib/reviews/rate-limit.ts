// Marketr — R4: per-token+IP rate limiter for the public review landing page.
// Mirrors lib/physical/bundles.ts checkRedeemRateLimit. The token is the
// capability; the limiter only blunts enumeration/brute-force against it.
//
// Deploy PR: the fixed window lives in the shared counter store
// (rate_limit_buckets via lib/api/rate-limit-store.ts sharedWindowHit) so it
// holds across web replicas; a store error falls back to the per-process
// window (the Phase 6 fail-open-to-local policy).

import { clientIpFromHeaders } from "@/lib/api/client-ip";
import { __resetLocalWindows, sharedWindowHit } from "@/lib/api/rate-limit-store";

export const REVIEW_PAGE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

export async function checkReviewPageRateLimit(token: string, ip: string, now: number = Date.now()): Promise<boolean> {
  const key = `review-page:${token.trim().slice(0, 64)}|${ip.trim().toLowerCase()}`;
  return (await sharedWindowHit(key, REVIEW_PAGE_LIMIT, now)).allowed;
}

/** Test hook: drop the per-process fallback windows. */
export function resetReviewPageRateLimits(): void {
  __resetLocalWindows();
}

export function clientIp(req: Request): string {
  return clientIpFromHeaders(req.headers) ?? "unknown";
}
