// ShapesOS — Phase 18.2 (WS=content): live-collaboration tokens (PURE + node
// crypto; no Hocuspocus here, so the Next route that mints them stays light).
//
// An authenticated route (app/api/collab/token) checks the workspace, the
// document and the member's rights, then mints a SHORT-LIVED token the
// browser hands to the collab server (lib/collab/server.ts) on connect. The
// token names exactly one document and whether the connection may write:
//   { v: 1, ws, doc: "note:<id>", uid, role: "write" | "read", name, color, exp }
// HMAC-SHA256 over the base64url JSON with a key derived from AUTH_SECRET
// (or NEXTAUTH_SECRET) for this purpose only — the same secret family as the
// data-room viewer and the store cart. No secret → collaboration is off
// (fail closed), never an unsigned token.

import { createHmac, timingSafeEqual } from "node:crypto";

export const COLLAB_TOKEN_TTL_MS = 5 * 60_000;
export const COLLAB_DOC_KINDS = ["note"] as const;
export type CollabDocKind = (typeof COLLAB_DOC_KINDS)[number];

export interface CollabClaims {
  v: 1;
  /** Workspace id — the server's RLS scope for every read and write. */
  ws: string;
  /** "<kind>:<id>" — the Hocuspocus document name; must match the connection's. */
  doc: string;
  uid: string;
  /** "read" connections are read-only on the server (updates are dropped). */
  role: "write" | "read";
  /** Shown on the member's caret. */
  name: string;
  color: string;
  /** Expiry, epoch ms. */
  exp: number;
}

type Env = Record<string, string | undefined>;

export function collabSecret(env: Env = process.env): string | null {
  const s = env.AUTH_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim();
  return s && s.length >= 16 ? s : null;
}

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("shapes:collab-token:v1").digest();
}

function mac(secret: string, body: string): string {
  return createHmac("sha256", key(secret)).update(body).digest("base64url");
}

/** "note:abc" → { kind, id } (known kinds and safe ids only). */
export function parseDocName(name: string): { kind: CollabDocKind; id: string } | null {
  const m = /^([a-z]+):([A-Za-z0-9_-]{1,64})$/.exec(name ?? "");
  if (!m || !(COLLAB_DOC_KINDS as readonly string[]).includes(m[1]!)) return null;
  return { kind: m[1] as CollabDocKind, id: m[2]! };
}

export function signCollabToken(claims: Omit<CollabClaims, "v" | "exp"> & { exp?: number }, secret: string, now = Date.now()): string {
  if (!parseDocName(claims.doc)) throw new Error("collab token: bad document name");
  const full: CollabClaims = { v: 1, ...claims, exp: claims.exp ?? now + COLLAB_TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

export type CollabVerify = { ok: true; claims: CollabClaims } | { ok: false; reason: "malformed" | "signature" | "expired" | "claims" };

export function verifyCollabToken(token: string, secret: string, now = Date.now()): CollabVerify {
  if (typeof token !== "string" || token.length > 4096) return { ok: false, reason: "malformed" };
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, reason: "malformed" };
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "signature" };
  let claims: CollabClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CollabClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    !claims ||
    claims.v !== 1 ||
    typeof claims.ws !== "string" ||
    !claims.ws ||
    typeof claims.uid !== "string" ||
    !claims.uid ||
    !parseDocName(claims.doc) ||
    (claims.role !== "write" && claims.role !== "read") ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, reason: "claims" };
  }
  if (claims.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

/**
 * A member's caret colour: one of the NEUTRAL tokens, by user id — never a
 * status colour (DESIGN.md: identity is the name, colour means agent state).
 */
export const CARET_COLORS = ["var(--aos-ink)", "var(--aos-text-muted)", "var(--aos-clay-4)", "var(--aos-text-subtle)", "var(--aos-line-strong)"] as const;

export function caretColor(userId: string): string {
  let h = 0;
  for (const c of userId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CARET_COLORS[h % CARET_COLORS.length]!;
}

/** The collab server's public ws(s):// URL the browser connects to; null = collaboration is off. */
export function collabPublicUrl(env: Env = process.env): string | null {
  const raw = (env.COLLAB_PUBLIC_URL ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "wss:" || u.protocol === "ws:" ? u.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}
