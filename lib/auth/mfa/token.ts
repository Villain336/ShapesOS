// ShapesOS — read the Auth.js session JWT from a request (Phase 4a).
//
// getToken() only looks at ONE cookie name: "authjs.session-token" unless
// told the deployment is https, where Auth.js names it
// "__Secure-authjs.session-token". Try the secure name first, then the plain
// one, so the proxy and the second-step providers work on both.

import { getToken, type JWT } from "next-auth/jwt";
import type { MfaTokenFields } from "./session-token";

export const SESSION_COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

export function authSecret(): string | undefined {
  return process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
}

/** True when the request carries an Auth.js session cookie at all (cheap pre-check). */
export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  return SESSION_COOKIE_NAMES.some((n) => cookieHeader.includes(`${n}=`) || cookieHeader.includes(`${n}.0=`));
}

/** Decode the session token (either cookie name); null when absent/invalid. */
export async function readSessionToken(req: { headers: Headers }): Promise<(JWT & MfaTokenFields) | null> {
  const secret = authSecret();
  if (!secret || !hasSessionCookie(req.headers.get("cookie"))) return null;
  for (const name of SESSION_COOKIE_NAMES) {
    try {
      const token = await getToken({
        req,
        secret,
        cookieName: name,
        salt: name,
        secureCookie: name.startsWith("__Secure-"),
      });
      if (token) return token as JWT & MfaTokenFields;
    } catch {
      // try the next name
    }
  }
  return null;
}
