// ShapesOS — CAPTCHA step-up after repeated login failures (Phase 4a; audit
// H9 follow-up "add a CAPTCHA/step-up after N failures").
//
// After LOGIN_CAPTCHA_AFTER_FAILURES (default 3) failed password sign-ins for
// an account OR from an IP inside the lockout window (lib/auth/rate-limit.ts),
// the credentials login also requires a CAPTCHA token, verified server-side
// with the provider before the password is even compared. It sits BELOW the
// existing lockout (5 account / 20 IP failures → capped backoff), so a human
// who mistypes can keep trying while a script hits the CAPTCHA wall first.
//
// Provider chosen by env (all optional):
//   CAPTCHA_PROVIDER     "turnstile" (Cloudflare) or "hcaptcha"
//   CAPTCHA_SITE_KEY     public widget key (rendered on /login)
//   CAPTCHA_SECRET_KEY   server-side verification secret
// With no provider configured — or a partial configuration — this is a
// documented no-op: sign-in falls back to the existing backoff only.
//
// Verification goes to the provider's fixed siteverify endpoint (not a
// user-supplied URL), with a 5 s timeout. Network errors fail CLOSED for
// that attempt (no token accepted) — the user can retry the challenge.

import { loginFailureCounts, loginFailureCountsAsync } from "./rate-limit";

export type CaptchaProvider = "turnstile" | "hcaptcha";

export interface CaptchaConfig {
  provider: CaptchaProvider;
  siteKey: string;
  secretKey: string;
  afterFailures: number;
}

export const DEFAULT_CAPTCHA_AFTER_FAILURES = 3;

const VERIFY_URL: Record<CaptchaProvider, string> = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  hcaptcha: "https://api.hcaptcha.com/siteverify",
};

let warnedPartial = false;

/** The configured provider, or null (feature off). */
export function captchaConfig(env: NodeJS.ProcessEnv = process.env): CaptchaConfig | null {
  const provider = (env.CAPTCHA_PROVIDER ?? "").trim().toLowerCase();
  if (!provider) return null;
  const siteKey = (env.CAPTCHA_SITE_KEY ?? "").trim();
  const secretKey = (env.CAPTCHA_SECRET_KEY ?? "").trim();
  if ((provider !== "turnstile" && provider !== "hcaptcha") || !siteKey || !secretKey) {
    if (!warnedPartial) {
      warnedPartial = true;
      console.warn(
        "[auth] CAPTCHA_PROVIDER is set but the CAPTCHA config is incomplete or unknown " +
          "(need turnstile|hcaptcha + CAPTCHA_SITE_KEY + CAPTCHA_SECRET_KEY) — step-up disabled, backoff only.",
      );
    }
    return null;
  }
  const n = Number((env.LOGIN_CAPTCHA_AFTER_FAILURES ?? "").trim());
  const afterFailures = Number.isInteger(n) && n >= 1 ? n : DEFAULT_CAPTCHA_AFTER_FAILURES;
  return { provider, siteKey, secretKey, afterFailures };
}

/** Public part for the login page (never the secret). */
export function publicCaptchaConfig(env: NodeJS.ProcessEnv = process.env): { provider: CaptchaProvider; siteKey: string } | null {
  const cfg = captchaConfig(env);
  return cfg ? { provider: cfg.provider, siteKey: cfg.siteKey } : null;
}

/** Does this sign-in attempt need a CAPTCHA? Always false with no provider. */
export function captchaRequired(
  ip: string | null,
  email: string,
  opts: { env?: NodeJS.ProcessEnv; now?: number } = {},
): boolean {
  const cfg = captchaConfig(opts.env);
  if (!cfg) return false;
  const counts = loginFailureCounts(ip, email, opts.now);
  return counts.account >= cfg.afterFailures || counts.ip >= cfg.afterFailures;
}

/**
 * Same decision over the shared (multi-replica) failure counts — what the
 * sign-in path calls (Phase 6). Falls back to the in-memory counts when the
 * shared store fails.
 */
export async function captchaRequiredAsync(
  ip: string | null,
  email: string,
  opts: { env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<boolean> {
  const cfg = captchaConfig(opts.env);
  if (!cfg) return false;
  const counts = await loginFailureCountsAsync(ip, email, opts.now);
  return counts.account >= cfg.afterFailures || counts.ip >= cfg.afterFailures;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "json">>;

/** Server-side token check with the provider. */
export async function verifyCaptchaToken(
  token: string | null | undefined,
  ip: string | null,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<boolean> {
  const cfg = captchaConfig(opts.env);
  if (!cfg) return true; // feature off: nothing to verify
  const value = (token ?? "").trim();
  if (!value || value.length > 4096) return false;
  const body = new URLSearchParams({ secret: cfg.secretKey, response: value });
  if (ip) body.set("remoteip", ip);
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const res = await doFetch(VERIFY_URL[cfg.provider], {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: unknown };
    return data?.success === true;
  } catch {
    return false;
  }
}
