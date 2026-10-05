// ShapesOS — trusted-proxy client IP (Phase 1 security).
//
// Every IP-keyed control (login lockout, API rate limits, vanity-redirect
// limits, public-form throttles, scan logs) reads the caller's address from
// here. The old code took the LEFTMOST X-Forwarded-For entry, which the
// client writes itself — rotating it bypassed every IP limit.
//
// Reverse proxies APPEND the address they saw to X-Forwarded-For, so the
// trustworthy entries are on the RIGHT. With N trusted proxies in front of
// the app (TRUSTED_PROXY_HOPS=N), the client is the Nth entry from the right;
// anything further left is client-supplied and ignored.
//
//   TRUSTED_PROXY_HOPS=1 (default)  one reverse proxy (nginx, Caddy, Traefik,
//                                   a PaaS edge) — or `next start` with no
//                                   proxy, where Next fills X-Forwarded-For
//                                   with the socket address.
//   TRUSTED_PROXY_HOPS=2            CDN → load balancer → app, etc.
//   TRUSTED_PROXY_HOPS=0            trust no proxy header at all: every
//                                   caller shares one "unknown" IP bucket.
//
// Note: Next only sets X-Forwarded-For when the request has none, so an app
// exposed directly to the internet cannot tell a spoofed header from the
// socket address — always run production behind a proxy that sets it.
//
// X-Real-IP is a single-value header set by the proxy; it is used only when
// X-Forwarded-For is absent and at least one proxy hop is trusted.

export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

/** TRUSTED_PROXY_HOPS as a non-negative integer (default 1). */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.TRUSTED_PROXY_HOPS ?? "").trim();
  if (!raw) return DEFAULT_TRUSTED_PROXY_HOPS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_TRUSTED_PROXY_HOPS;
}

type HeaderSource = Pick<Headers, "get">;

/**
 * The client address as seen by the outermost trusted proxy, or null when
 * it can't be determined. Pass `hops` to override TRUSTED_PROXY_HOPS (tests).
 */
export function clientIpFromHeaders(
  headers: HeaderSource | null | undefined,
  hops: number = trustedProxyHops(),
): string | null {
  if (!headers || hops <= 0) return null;
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const chain = fwd
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (chain.length === 0) return null;
    // Fewer entries than trusted hops: the request skipped part of the proxy
    // chain; the leftmost entry is still the furthest address any proxy saw.
    return chain[Math.max(0, chain.length - hops)] ?? null;
  }
  return headers.get("x-real-ip")?.trim() || null;
}
