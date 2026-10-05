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

import { __resetLocalWindows, sharedWindowHit } from "@/lib/api/rate-limit-store";
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

/** Test seam: drop the per-process fallback windows. */
export function __resetStoreLimits(): void {
  __resetLocalWindows();
}

export async function storeHit(kind: keyof typeof STORE_LIMITS, storeId: string, ip: string | null, now: number = Date.now()): Promise<StoreHit> {
  return publicEndpointHit(`shop:${kind}`, STORE_LIMITS[kind], storeId, ip, now);
}

/**
 * Fixed-window hit for any public endpoint, keyed scope + resource id +
 * client IP (Phase 12 (people): event registration reuses it). Shared
 * counter store when configured, the per-process fallback otherwise.
 */
export async function publicEndpointHit(
  scope: string,
  rule: { limit: number; windowMs: number },
  resourceId: string,
  ip: string | null,
  now: number = Date.now(),
): Promise<StoreHit> {
  const hit = await sharedWindowHit(`${scope}:${resourceId}:${ip ?? "no-ip"}`, rule, now);
  return { allowed: hit.allowed, count: hit.count, retryAfterMs: hit.retryAfterMs };
}

/** CAPTCHA due for this checkout attempt? (never without a provider) */
export function checkoutCaptchaDue(attempt: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return captchaConfig(env) !== null && attempt >= CHECKOUT_CAPTCHA_AFTER;
}

export { verifyCaptchaToken };
