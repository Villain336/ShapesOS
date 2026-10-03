// ShapesOS — request proxy (Next.js 16 "proxy", formerly middleware).
//
// Every request except static assets — Content-Security-Policy (Phase 3):
//   a fresh nonce per request; the policy (lib/security/headers.ts, the single
//   source of truth) goes on the REQUEST headers — Next's renderer parses the
//   nonce out of it and stamps it on its own scripts — and on the response.
//   /api/* gets the scriptless API policy instead (no nonce involved).
//
// API requests only — single choke point for Fix 6 (Phase A hardening):
//   1. Oversize-body guard: declared Content-Length past the cap → 400
//      (kept at 400 per the Fix 6 adversarial contract: malformed/oversize
//      bodies are 400, exhausted budgets are 429).
//   2. Tiered rate limiting (see lib/api/rate-limit.ts):
//        auth  /api/auth/* (except session/csrf/providers)  10 req/min per IP
//        read  GET/HEAD/OPTIONS                              120 req/min per user
//        write POST/PUT/PATCH/DELETE                         60 req/min per user
//        ai    LLM / skill-execution routes                  20 req/min per user
//
// Runs on the Node.js runtime (Next 16 default). The limiter is in-memory and
// single-instance by design — same documented stance as lib/auth/rate-limit.ts.
// Front with a shared limiter (Redis etc.) if you run replicas.
//
// NOTE: this intentionally does NOT validate request bodies — body schemas
// live per-route via lib/api/validate.ts (zod), where the shape is known.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hasSessionCookie, readSessionToken } from "./lib/auth/mfa/token";
import { pendingSubject } from "./lib/auth/mfa/session-token";
import {
  classifyTier,
  checkRateLimit,
  rateLimitKey,
  tooManyRequests,
  clientIp,
} from "./lib/api/rate-limit";
import { contentSecurityPolicyFor, generateCspNonce } from "./lib/security/headers";

export const config = {
  matcher: [
    // Every API route — rate limiting must see all of them, whatever the suffix.
    "/api/:path*",
    // Everything else except build output, the image optimizer and static
    // files from public/ (they need no CSP; skipping them keeps assets cheap).
    "/((?!api/|_next/static/|_next/image|favicon\\.ico$|.*\\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|map)$).*)",
  ],
};

/** Hard backstop on declared body size — the route layer never buffers past this. */
export const MAX_API_CONTENT_LENGTH = 10 * 1024 * 1024; // 10 MiB

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** Signed-in app surfaces a pending second-factor session is bounced from. */
function isAppShellPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/") || pathname === "/security/setup";
}

export async function proxy(req: NextRequest) {
  // 0. Content-Security-Policy. The policy rides on the forwarded request
  //    (Next reads the nonce from it; server components can read x-nonce)
  //    and on every response this proxy produces.
  const nonce = generateCspNonce();
  const csp = contentSecurityPolicyFor(req.nextUrl.pathname, {
    nonce,
    dev: process.env.NODE_ENV === "development",
  });
  const withCsp = <T extends Response>(res: T): T => {
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };
  const pass = () => {
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("content-security-policy", csp);
    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
  };

  if (!isApiPath(req.nextUrl.pathname)) {
    // Phase 4a: a sign-in waiting on its second factor never reaches the app
    // shell — send it back to /login to finish (the session itself already
    // exposes no user, so every server guard denies it regardless).
    if (isAppShellPath(req.nextUrl.pathname) && hasSessionCookie(req.headers.get("cookie"))) {
      const token = await readSessionToken(req).catch(() => null);
      if (pendingSubject(token, Math.floor(Date.now() / 1000))) {
        const url = new URL("/login", req.nextUrl);
        url.searchParams.set("next", `${req.nextUrl.pathname}${req.nextUrl.search}`);
        return withCsp(NextResponse.redirect(url));
      }
    }
    return pass();
  }

  // 1. Oversize-body guard (declared length only; chunked streams are bounded
  //    per-route by body readers).
  const declared = req.headers.get("content-length");
  if (declared !== null && declared !== "") {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_API_CONTENT_LENGTH) {
      return withCsp(
        NextResponse.json({ error: "Request body too large (max 10 MiB)." }, { status: 400 }),
      );
    }
  }

  // 2. Tiered rate limiting.
  const pathname = req.nextUrl.pathname;
  const tier = classifyTier(pathname, req.method);

  // Resolve the user id for per-user tiers. Auth tier is IP-keyed by design.
  // Any failure (no session, undecryptable token, missing secret) degrades to
  // IP-keyed limiting rather than failing open or closed.
  let userId: string | null = null;
  if (tier !== "auth") {
    try {
      // Phase 4a: reads either session cookie name (https deployments use the
      // __Secure- prefix); a pending second-factor token has no sub → IP key.
      const token = await readSessionToken(req);
      userId = typeof token?.sub === "string" && token.sub ? token.sub : null;
    } catch {
      userId = null;
    }
  }

  const key = rateLimitKey(tier, userId, clientIp(req.headers));
  const result = checkRateLimit(key, tier);
  if (!result.allowed) {
    return withCsp(tooManyRequests(result.retryAfterMs));
  }

  return pass();
}
