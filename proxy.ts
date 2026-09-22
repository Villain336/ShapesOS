// Marketr — API proxy (Next.js 16 "proxy", formerly middleware).
//
// Single choke point for Fix 6 (Phase A hardening):
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
import { getToken } from "next-auth/jwt";
import {
  classifyTier,
  checkRateLimit,
  rateLimitKey,
  tooManyRequests,
  clientIp,
} from "./lib/api/rate-limit";

export const config = {
  matcher: "/api/:path*",
};

/** Hard backstop on declared body size — the route layer never buffers past this. */
export const MAX_API_CONTENT_LENGTH = 10 * 1024 * 1024; // 10 MiB

export async function proxy(req: NextRequest) {
  // 1. Oversize-body guard (declared length only; chunked streams are bounded
  //    per-route by body readers).
  const declared = req.headers.get("content-length");
  if (declared !== null && declared !== "") {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_API_CONTENT_LENGTH) {
      return NextResponse.json(
        { error: "Request body too large (max 10 MiB)." },
        { status: 400 },
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
      const token = await getToken({
        req,
        secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
      });
      userId = typeof token?.sub === "string" && token.sub ? token.sub : null;
    } catch {
      userId = null;
    }
  }

  const key = rateLimitKey(tier, userId, clientIp(req.headers));
  const result = checkRateLimit(key, tier);
  if (!result.allowed) {
    return tooManyRequests(result.retryAfterMs);
  }

  return NextResponse.next();
}
