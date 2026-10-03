// ShapesOS — response security headers (Phase 1 untrusted content, Phase 3
// nonce CSP). Single source of truth for every security header the app sends.
//
// Imported by next.config.ts (relative import, no path aliases, no deps), by
// proxy.ts (per-request CSP) and by route handlers that serve user bytes.
//
// Who sends what:
//   - next.config.ts `headers()` — the STATIC set (nosniff, frame options,
//     referrer, permissions, HSTS). Resolved at build time, so nothing here
//     may depend on runtime env: one image serves https and plain-http LAN
//     installs. It must NOT send Content-Security-Policy: Next applies config
//     headers before the proxy's, and two CSP headers would intersect.
//   - proxy.ts — Content-Security-Policy, per request:
//       pages / route handlers outside /api → buildContentSecurityPolicy()
//         with a fresh nonce (also put on the REQUEST headers, where Next's
//         renderer reads it and stamps it on its own <script> tags — see
//         node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md);
//       /api/*                               → API_CONTENT_SECURITY_POLICY.
//
// Page policy (script-src) — strict CSP:
//   'nonce-…' 'strict-dynamic': only scripts Next rendered with the nonce run,
//     plus whatever those scripts load at runtime (code-split chunks, Monaco's
//     AMD loader from cdn.jsdelivr.net, next/script tags such as Umami — Next
//     passes the nonce to next/script automatically). Injected markup
//     (<script>, <img onerror>, javascript: URLs) never runs.
//   'self' https: are ignored by CSP3 browsers when 'strict-dynamic' is
//     present; they are the fallback for CSP2-only browsers.
//   No 'unsafe-inline'. No 'unsafe-eval' in production (Next/React only eval
//     in dev, for server-error stack reconstruction; Monaco, Univer and
//     Payload were browser-verified without it — docs/audit/CSP.md).
//   script-src-attr 'none' stays as belt-and-braces against handler injection.
//   NOTE: script-src must stay the FIRST script-src* directive — Next picks the
//     nonce from the first directive that startsWith("script-src").
// Other page directives are unchanged from Phase 1: inline styles allowed
// (React style props, Monaco/Univer inject <style>), user content (images,
// media, embeds) from any http(s) host (CDNs, LAN MinIO presigned URLs),
// workers same-origin/blob only, no plugins, no <base> hijack, framing
// same-origin only (matches X-Frame-Options SAMEORIGIN). No
// upgrade-insecure-requests (breaks plain-http LAN installs).
//
// Every page must be dynamically rendered for its nonce to reach the HTML —
// app/layout.tsx awaits connection() so nothing is prerendered at build time.

/**
 * A fresh, unpredictable nonce: 128 bits from the platform CSPRNG, base64.
 * Web Crypto only (no node: import) so the proxy bundle stays portable.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const NONCE_RE = /^[A-Za-z0-9+/]{16,}={0,2}$/;

export function buildContentSecurityPolicy(opts: { nonce: string; dev?: boolean }): string {
  // A malformed nonce would make Next drop it silently and every script would
  // be blocked; fail loudly instead.
  if (!NONCE_RE.test(opts.nonce)) throw new Error("CSP nonce must be base64 (>=128 bits)");
  const scriptSrc = [
    "'self'",
    `'nonce-${opts.nonce}'`,
    "'strict-dynamic'",
    "https:",
    // Dev only: React's dev build evals to rebuild server error stacks.
    ...(opts.dev ? ["'unsafe-eval'"] : []),
  ].join(" ");
  return [
    `script-src ${scriptSrc}`,
    "script-src-attr 'none'",
    "default-src 'self'",
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
 * CSP for every /api/* response. API responses are JSON, JS for external
 * embedding, user bytes (downloads, logos) or a handful of tiny static HTML
 * pages (unsubscribe confirmations, OAuth error, newsletter previews) — none
 * of which may run script. CSP on fetch()/XHR responses is ignored by
 * browsers, so this only bites when a response is opened as a document:
 * then it is a scriptless, sandboxed (opaque-origin → no session cookies on
 * form posts) page that can still show images/styles and submit its own
 * forms.
 *
 * This header wins over a CSP a route handler sets itself (Next keeps the
 * proxy's header and drops the route's duplicate), which is why it is at
 * least as strict as USER_CONTENT_CSP / the download "sandbox" policy for
 * script, plugins and origin.
 */
export const API_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "img-src 'self' data: blob: https: http:",
  "style-src 'unsafe-inline' https:",
  "font-src data: https:",
  "media-src 'self' data: blob: https: http:",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "sandbox allow-forms allow-popups allow-popups-to-escape-sandbox",
].join("; ");

/** Which policy a request path gets (see header comment). */
export function contentSecurityPolicyFor(
  pathname: string,
  opts: { nonce: string; dev?: boolean },
): string {
  if (pathname === "/api" || pathname.startsWith("/api/")) return API_CONTENT_SECURITY_POLICY;
  return buildContentSecurityPolicy(opts);
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

/**
 * The static headers next.config.ts sends on every response. Deliberately no
 * Content-Security-Policy — proxy.ts owns that (per-request nonce).
 */
export function buildSecurityHeaders(opts: { hsts: boolean }): Array<{ key: string; value: string }> {
  return [
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
