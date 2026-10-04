// ShapesOS — Phase 10 (store): per-store + per-IP limits for the public
// storefront endpoints, and the CAPTCHA step-up for checkout.
//
// On top of proxy.ts's tiered limiter (every /api/* request; anonymous
// buyers are IP-keyed there), each public storefront endpoint has its own
// fixed window per store and client IP. The window lives in the shared
// Postgres counter store when RATE_LIMIT_STORE selects it (multi-replica),
// and falls back to the per-process limiter if that store errors or is slow
// — the same fail-open-to-local policy as the rest of the limiter.
//
// Bot protection: checkout creation reuses the login CAPTCHA machinery
// (lib/auth/captcha.ts — Turnstile or hCaptcha, CAPTCHA_PROVIDER + keys).
// With a provider configured, a CAPTCHA is required from the
// CHECKOUT_CAPTCHA_AFTER-th checkout attempt per store+IP inside the window
// (a person retrying after a declined card isn't challenged on the first
// try; a script is). Without a provider this step is a documented no-op.

import { sharedCounterStore, withStoreTimeout, storeWarn } from "@/lib/api/rate-limit-store";
import { captchaConfig, verifyCaptchaToken } from "@/lib/auth/captcha";

export const STORE_LIMITS = {
  cart: { limit: 60, windowMs: 60_000 },
  checkout: { limit: 10, windowMs: 10 * 60_000 },
} as const;

export const CHECKOUT_CAPTCHA_AFTER = 2;

export interface StoreHit {
  allowed: boolean;
  /** Hits in the current window, this one included. */
  count: number;
  retryAfterMs: number;
}

// Per-process fallback (bounded: oldest key evicted past 10k).
const localCounts = new Map<string, { n: number; start: number }>();

/** Test seam. */
export function __resetStoreLimits(): void {
  localCounts.clear();
}

function localHit(key: string, windowMs: number, now: number): { n: number; start: number } {
  const cur = localCounts.get(key);
  if (!cur || now - cur.start >= windowMs) {
    const fresh = { n: 1, start: now };
    localCounts.set(key, fresh);
    if (localCounts.size > 10_000) {
      const oldest = localCounts.keys().next().value;
      if (oldest) localCounts.delete(oldest);
    }
    return fresh;
  }
  cur.n += 1;
  return cur;
}

export async function storeHit(kind: keyof typeof STORE_LIMITS, storeId: string, ip: string | null, now: number = Date.now()): Promise<StoreHit> {
  const { limit, windowMs } = STORE_LIMITS[kind];
  const key = `shop:${kind}:${storeId}:${ip ?? "no-ip"}`;
  const store = sharedCounterStore();
  if (store) {
    try {
      const hit = await withStoreTimeout(store.hit(key, windowMs, now));
      return { allowed: hit.count <= limit, count: hit.count, retryAfterMs: hit.count <= limit ? 0 : Math.max(0, hit.windowStart + windowMs - now) };
    } catch (err) {
      storeWarn("shop-hit", err);
    }
  }
  const h = localHit(key, windowMs, now);
  return { allowed: h.n <= limit, count: h.n, retryAfterMs: h.n <= limit ? 0 : Math.max(0, h.start + windowMs - now) };
}

/** CAPTCHA due for this checkout attempt? (never without a provider) */
export function checkoutCaptchaDue(attempt: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return captchaConfig(env) !== null && attempt >= CHECKOUT_CAPTCHA_AFTER;
}

export { verifyCaptchaToken };
