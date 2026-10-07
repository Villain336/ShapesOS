// ShapesOS — Phase 19A (WS=server): the cursor session token (PURE + node
// crypto).
//
// ShapesOS Desktop signs in inside its main window exactly like a browser;
// its main process then calls POST /api/cursor/session with that session's
// cookies and gets this SHORT-LIVED token back, so the overlay process can
// call /api/cursor/* with `Authorization: Bearer <token>` without holding the
// cookie. The token names exactly one user and one workspace:
//   { v: 1, uid, ws, iat, exp }  (exp − iat ≤ 10 minutes)
// HMAC-SHA256 over the base64url JSON with a key derived from AUTH_SECRET
// (or NEXTAUTH_SECRET) for this purpose only. No secret → no token (the
// routes then accept the cookie alone): never an unsigned token.
//
// The token is a credential for the cursor routes only. Every request with
// it is still checked against the CURRENT membership (a removed member's
// token stops working at once) — see lib/cursor/http.ts.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Lifetime of a cursor token. The contract caps it at 10 minutes. */
export const CURSOR_TOKEN_TTL_MS = 10 * 60_000;
export const CURSOR_TOKEN_PREFIX = "cur1.";

export interface CursorTokenClaims {
  v: 1;
  /** User id. */
  uid: string;
  /** Workspace id the token is bound to. */
  ws: string;
  /** Issued at, epoch ms. */
  iat: number;
  /** Expiry, epoch ms. */
  exp: number;
}

type Env = Record<string, string | undefined>;

export function cursorTokenSecret(env: Env = process.env): string | null {
  const s = env.AUTH_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim();
  return s && s.length >= 16 ? s : null;
}

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("shapes:cursor-token:v1").digest();
}

function mac(secret: string, body: string): string {
  return createHmac("sha256", key(secret)).update(body).digest("base64url");
}

export function signCursorToken(input: { userId: string; workspaceId: string }, secret: string, now = Date.now()): { token: string; expiresAt: number } {
  if (!input.userId || !input.workspaceId) throw new Error("cursor token: user and workspace are required");
  const claims: CursorTokenClaims = { v: 1, uid: input.userId, ws: input.workspaceId, iat: now, exp: now + CURSOR_TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { token: `${CURSOR_TOKEN_PREFIX}${body}.${mac(secret, body)}`, expiresAt: claims.exp };
}

export type CursorTokenVerify =
  | { ok: true; claims: CursorTokenClaims }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "claims" | "workspace" };

/**
 * Verify a token. With `workspaceId`, a token bound to another workspace is
 * refused ("workspace") even when it is otherwise valid.
 */
export function verifyCursorToken(token: string, secret: string, opts: { now?: number; workspaceId?: string } = {}): CursorTokenVerify {
  const now = opts.now ?? Date.now();
  if (typeof token !== "string" || token.length > 2048 || !token.startsWith(CURSOR_TOKEN_PREFIX)) return { ok: false, reason: "malformed" };
  const [body, sig, extra] = token.slice(CURSOR_TOKEN_PREFIX.length).split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, reason: "malformed" };
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "signature" };
  let claims: CursorTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    !claims ||
    claims.v !== 1 ||
    typeof claims.uid !== "string" ||
    !claims.uid ||
    typeof claims.ws !== "string" ||
    !claims.ws ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    // Never longer-lived than the contract allows, whatever was signed.
    claims.exp - claims.iat > CURSOR_TOKEN_TTL_MS
  ) {
    return { ok: false, reason: "claims" };
  }
  if (claims.exp <= now) return { ok: false, reason: "expired" };
  if (opts.workspaceId && claims.ws !== opts.workspaceId) return { ok: false, reason: "workspace" };
  return { ok: true, claims };
}

/** The bearer token of a request, if it carries a cursor token. */
export function bearerCursorToken(headers: Headers): string | null {
  const h = headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  if (!m || !m[1]!.startsWith(CURSOR_TOKEN_PREFIX)) return null;
  return m[1]!;
}
