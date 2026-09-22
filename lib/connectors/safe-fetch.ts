// Marketr — SSRF-safe fetch for operator-configured URLs (day-1, M6).
//
// The central request path every WordPress operation must use. It closes the
// gaps in construction-time-only validation:
//   - every request re-validates the URL (scheme, credentials, DNS → no
//     loopback/private/link-local/metadata), narrowing DNS rebinding to the
//     lookup→connect gap inherent to fetch;
//   - redirects are followed MANUALLY (redirect: "manual") and every hop is
//     re-validated — a compromised/misconfigured server cannot bounce the
//     request to 169.254.169.254 or another internal address;
//   - redirect following is capped (default 5 hops).
//
// Redirect semantics: 301/302/303 convert to GET and drop the body (browser
// behavior — the Authorization header is NOT resent with a body to a new
// location); 307/308 preserve method and body but only to a validated URL.
// Non-GET requests never have their body forwarded cross-origin implicitly:
// the hop is validated first, and only 307/308 keep the body per spec.
//
// Tests inject `resolve` (fake DNS) and `fetchFn` (fake fetch) — no network.

import { assertSafeUrl, UnsafeUrlError, type ResolveFn } from "@/lib/safe-url";

export interface SafeFetchOptions {
  resolve?: ResolveFn;
  fetchFn?: typeof fetch;
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(
  url: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxRedirects = opts.maxRedirects ?? 5;
  // Validate, but fetch the ORIGINAL url string: assertSafeUrl normalizes
  // (trailing-slash trim), which must not rewrite the request target.
  await assertSafeUrl(url, { resolve: opts.resolve });
  let current = url;
  let method = (init.method ?? "GET").toUpperCase();
  let headers = init.headers;
  let body = init.body;

  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchFn(current, { ...init, method, headers, body, redirect: "manual" });
    } catch (err) {
      throw new Error(
        `Safe request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const location = res.headers.get("location");
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
    if (hop >= maxRedirects) {
      throw new UnsafeUrlError("Too many redirects.");
    }
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new UnsafeUrlError("Invalid redirect location.");
    }
    // Re-validate EVERY hop: DNS is re-resolved, so a redirect to an
    // internal address (or a rebinding hostname) is rejected here.
    await assertSafeUrl(next, { resolve: opts.resolve });
    current = next;
    if (res.status === 301 || res.status === 302 || res.status === 303) {
      // Browser behavior: drop the body, follow as GET.
      method = "GET";
      body = undefined;
    }
    // 307/308 keep method + body by spec, now pointed at a validated URL.
  }
}
