// ShapesOS — response security headers (Phase 1, untrusted content).
//
// Imported by next.config.ts (relative import, no path aliases, no deps) and
// by route handlers that serve user-supplied bytes.
//
// next.config headers are resolved at BUILD time (routes-manifest), so the
// CSP must not depend on runtime env: the same image serves https installs
// and plain-http LAN installs.
//
// Content-Security-Policy, app-wide. Compatibility constraints that shape it:
//   - Next's inline bootstrap scripts are not nonce'd (static config, no
//     per-request proxy), so script-src keeps 'unsafe-inline'; Monaco loads
//     from cdn.jsdelivr.net and Umami's script URL is runtime-configured, so
//     external scripts are allowed over https: only; 'unsafe-eval' is kept
//     for Monaco's worker bootstrap and dev tooling.
//   - script-src-attr 'none' is the XSS teeth: an injected
//     <img onerror=…>/<svg onload=…> never runs, even with 'unsafe-inline'
//     for <script> elements. React never emits inline handler attributes.
//   - object-src 'none', base-uri 'self', frame-ancestors 'self' (matches
//     X-Frame-Options SAMEORIGIN), form-action limited, workers
//     same-origin/blob only.
//   - user content (images, media, embeds) may come from any http(s) host
//     (CDNs, S3/MinIO presigned URLs on LAN installs).
// A nonce-based script-src (proxy-generated, every page dynamic) is the
// follow-up that would let 'unsafe-inline'/'unsafe-eval' go.

export function buildContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data: https:",
    "connect-src 'self' https: http: wss: ws: blob: data:",
    "media-src 'self' data: blob: https: http:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob: data: https: http:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https: http:",
    "frame-ancestors 'self'",
  ].join("; ");
}

/**
 * CSP for responses that carry user-supplied bytes (uploaded logos, file
 * downloads): a sandboxed, resource-less document — even if a browser
 * renders the bytes as HTML/SVG, no script runs and nothing loads.
 */
export const USER_CONTENT_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/**
 * HSTS is sent unless the deployment is explicitly plain http (NEXTAUTH_URL
 * http://…). Browsers ignore HSTS on http responses, so a LAN install that
 * never sets NEXTAUTH_URL loses nothing; previously HSTS required
 * NEXTAUTH_URL at BUILD time, which Docker builds never have.
 */
export function shouldSendHsts(env: { NODE_ENV?: string; NEXTAUTH_URL?: string }): boolean {
  if (env.NODE_ENV !== "production") return false;
  return !(env.NEXTAUTH_URL ?? "").trim().toLowerCase().startsWith("http://");
}

export function buildSecurityHeaders(opts: { hsts: boolean }): Array<{ key: string; value: string }> {
  return [
    { key: "Content-Security-Policy", value: buildContentSecurityPolicy() },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=()",
    },
    ...(opts.hsts
      ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
      : []),
  ];
}
