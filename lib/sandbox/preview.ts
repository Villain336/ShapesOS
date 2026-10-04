// ShapesOS — Phase 8: sandbox previews (shared, PURE parts).
//
// A dev server inside a sandbox is never reachable directly from a browser:
// every provider's exposePort() returns the app's own authenticated route,
// /api/agent-runs/<runId>/preview/<port>/, and that route proxies to the
// provider-side upstream (Docker: the sandbox gateway on the Docker host's
// loopback; E2B / Daytona: their private preview host, with the access token
// header only the server holds).
//
// Dev servers must be started with that path as their base path (Vite
// `--base`, Next `basePath`, …): absolute asset URLs that point at `/` would
// otherwise hit the app, not the sandbox. The tools tell the agent so.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Sandbox } from "./types";
import { SANDBOX_PREVIEW_CSP } from "@/lib/security/headers";

export const PREVIEW_ROUTE_PREFIX = "/api/agent-runs";

/** The app path a browser opens for `port` of a run's sandbox. */
export function previewPath(runId: string, port: number): string {
  return `${PREVIEW_ROUTE_PREFIX}/${encodeURIComponent(runId)}/preview/${port}/`;
}

export function isValidPreviewPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/** Where the preview route sends the request, and what proves it may. */
export interface PreviewUpstream {
  /** Origin to proxy to (no trailing slash), e.g. http://127.0.0.1:49153. */
  origin: string;
  /** Headers the upstream needs (gateway / provider access token). */
  headers: Record<string, string>;
  /**
   * "loopback": the Docker gateway — allowed ONLY at exactly this origin
   * (safe-url would rightly refuse loopback for anything else).
   * "public": a provider host — must pass assertSafeUrl AND match `hostPattern`.
   */
  kind: "loopback" | "public";
  hostPattern?: RegExp;
}

/** A sandbox that can name its preview upstream (every provider here can). */
export interface PreviewCapable {
  previewUpstream(port: number): Promise<PreviewUpstream>;
}

export function isPreviewCapable(s: Sandbox): s is Sandbox & PreviewCapable {
  return typeof (s as Partial<PreviewCapable>).previewUpstream === "function";
}

/**
 * Is `url` an allowed upstream for `up`? Loopback upstreams must match the
 * gateway origin exactly; public ones must be https and match the provider's
 * per-sandbox host pattern. (The DNS half of safe-url runs in the route.)
 */
export function upstreamAllowed(url: URL, up: PreviewUpstream): boolean {
  if (up.kind === "loopback") return url.origin === up.origin;
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return !!up.hostPattern && up.hostPattern.test(url.hostname) && url.origin === up.origin;
}

/** Request headers never forwarded to a sandbox (the app's own credentials). */
const DROP_REQUEST = new Set([
  "cookie",
  "authorization",
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "content-length",
]);

export function forwardRequestHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    const key = k.toLowerCase();
    if (DROP_REQUEST.has(key) || key.startsWith("x-shapes-") || key.startsWith("x-daytona-") || key.startsWith("e2b-")) return;
    out[key] = v;
  });
  return out;
}

const DROP_RESPONSE = new Set([
  "set-cookie",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "access-control-allow-origin",
  "access-control-allow-credentials",
]);

/**
 * Response headers for a preview. The sandbox's page is untrusted (an agent
 * built it, maybe from injected instructions), so it runs under a CSP
 * `sandbox` — an opaque origin: its scripts can't read the app's cookies or
 * storage, and its requests to the app are cross-site (the Lax session
 * cookie is not sent). It can't set cookies on the app's origin either.
 */
export function previewResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((v, k) => {
    if (!DROP_RESPONSE.has(k.toLowerCase())) out.set(k, v);
  });
  // proxy.ts sends the same policy for preview paths (its header wins over a
  // route's); set here too so both always agree.
  out.set("content-security-policy", SANDBOX_PREVIEW_CSP);
  out.set("x-content-type-options", "nosniff");
  out.set("referrer-policy", "no-referrer");
  out.set("cache-control", "no-store");
  out.set("x-robots-tag", "noindex");
  return out;
}

// ---------------------------------------------------------------------------
// Preview capability cookie. The CSP sandbox above makes the preview page an
// opaque origin, so ITS subresource requests (scripts, styles, fetches back
// to the preview path) are cross-site and carry no Lax session cookie. The
// first, session-authenticated, top-level request therefore sets a short-
// lived cookie scoped to that one run's preview path (HttpOnly, SameSite=None,
// Secure), holding an HMAC over (run, user, workspace, expiry) keyed off
// AUTH_SECRET with a purpose-derived key. It opens nothing but this run's
// preview, and the route still re-checks the user's workspace membership.
// No AUTH_SECRET → no cookie: previews then work only for same-origin loads.
// ---------------------------------------------------------------------------


export const PREVIEW_COOKIE = "shapes_preview";
export const PREVIEW_TOKEN_TTL_SECONDS = 60 * 60;

export function previewSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.AUTH_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim();
  return s ? s : null;
}

function previewMac(secret: string, body: string): string {
  const key = createHmac("sha256", secret).update("shapes:sandbox-preview:v1").digest();
  return createHmac("sha256", key).update(body).digest("base64url");
}

export interface PreviewClaims {
  runId: string;
  userId: string;
  workspaceId: string;
  /** Unix seconds. */
  exp: number;
}

export function signPreviewToken(c: PreviewClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify([c.runId, c.userId, c.workspaceId, c.exp])).toString("base64url");
  return `${body}.${previewMac(secret, body)}`;
}

/** The claims when the token is genuine, unexpired and for `runId`; else null. */
export function verifyPreviewToken(token: string | undefined | null, runId: string, secret: string, nowSec = Date.now() / 1000): PreviewClaims | null {
  if (!token || token.length > 2048) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const got = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(previewMac(secret, body));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const [r, u, w, exp] = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as [string, string, string, number];
    if (r !== runId || typeof u !== "string" || typeof w !== "string" || typeof exp !== "number" || exp < nowSec) return null;
    return { runId: r, userId: u, workspaceId: w, exp };
  } catch {
    return null;
  }
}

/** Read one cookie from a Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
