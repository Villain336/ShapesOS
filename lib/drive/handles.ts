// ShapesOS — Phase 21B (WS=drive): file-picker handles (PURE + node crypto).
//
// When a person picks a file for an app ("Open with…", a file field), the app does
// NOT get the tree or a path: it gets ONE opaque handle that names exactly one file,
// one app install, one mode (read or readwrite) and an expiry, signed with a key
// derived from AUTH_SECRET for this purpose only. Using it re-checks the person's
// current access to the file, so taking access away takes the handle away too.
// No secret -> handles are off (fail closed), never an unsigned handle.

import { createHmac, timingSafeEqual } from "node:crypto";

export const HANDLE_DEFAULT_TTL_MS = 60 * 60_000;
export const HANDLE_MAX_TTL_MS = 24 * 60 * 60_000;

export interface HandleClaims {
  v: 1;
  /** Workspace id. */
  ws: string;
  /** "<appId>/<install>" — the only app that may use it. */
  app: string;
  /** The one file. */
  file: string;
  /** The person who picked it. */
  by: string;
  mode: "read" | "readwrite";
  /** Expiry, epoch ms. */
  exp: number;
}

type Env = Record<string, string | undefined>;

export function handleSecret(env: Env = process.env): string | null {
  const s = env.AUTH_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim();
  return s && s.length >= 16 ? s : null;
}

function mac(secret: string, body: string): string {
  const key = createHmac("sha256", secret).update("shapes:drive-handle:v1").digest();
  return createHmac("sha256", key).update(body).digest("base64url");
}

export function signHandle(claims: Omit<HandleClaims, "v" | "exp">, secret: string, opts: { now?: number; ttlMs?: number } = {}): string {
  if (!secret) throw new Error("A signing secret is required for file handles.");
  const now = opts.now ?? Date.now();
  const ttl = Math.min(Math.max(1000, opts.ttlMs ?? HANDLE_DEFAULT_TTL_MS), HANDLE_MAX_TTL_MS);
  const full: HandleClaims = { v: 1, ...claims, exp: now + ttl };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

export type HandleVerify = { ok: true; claims: HandleClaims } | { ok: false; reason: "malformed" | "signature" | "expired" | "app" | "claims" };

export function verifyHandle(handle: string, secret: string, expect: { app: string; now?: number }): HandleVerify {
  if (typeof handle !== "string" || handle.length > 2048) return { ok: false, reason: "malformed" };
  const parts = handle.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, sig] = parts as [string, string];
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "signature" };
  let claims: HandleClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as HandleClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (claims.v !== 1 || typeof claims.ws !== "string" || typeof claims.file !== "string" || typeof claims.by !== "string" || (claims.mode !== "read" && claims.mode !== "readwrite")) return { ok: false, reason: "claims" };
  if ((expect.now ?? Date.now()) > claims.exp) return { ok: false, reason: "expired" };
  if (claims.app !== expect.app) return { ok: false, reason: "app" };
  return { ok: true, claims };
}
