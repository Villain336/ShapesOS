// ShapesOS — dev-preview capability cookie.
//
// Why this exists: preview responses carry SANDBOX_PREVIEW_CSP, whose
// `sandbox` directive (no allow-same-origin) makes the preview document an
// OPAQUE origin. Its subresource requests (module scripts, CSS, client
// fetches) are then cross-site and carry no SameSite=Lax session cookie -
// observed in a real Chromium harness: the iframe document authenticates,
// but every asset the served app references 401s. Same problem the
// agent-runs preview solved with an HMAC capability cookie; this is the
// dev-preview equivalent, scoped to one project's one port.
//
// The cookie opens GET/HEAD preview reads only (canWrite=false); mutating
// verbs still need an editor session. Issued only after full session auth on
// the document request. No AUTH_SECRET -> no cookie -> previews work only
// for same-origin loads (same fail-closed posture as the agent-runs preview).

import { createHmac, timingSafeEqual } from "node:crypto";

export const DEV_PREVIEW_COOKIE = "shapes_dev_preview_cap";
export const DEV_PREVIEW_TOKEN_TTL_SECONDS = 60 * 60;

function secret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.AUTH_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim();
  return s || null;
}

function mac(keySecret: string, body: string): string {
  const key = createHmac("sha256", keySecret).update("shapes:dev-preview:v1").digest();
  return createHmac("sha256", key).update(body).digest("base64url");
}

export interface DevPreviewClaims {
  projectId: string;
  port: number;
  userId: string;
  workspaceId: string;
  /** Unix seconds. */
  exp: number;
}

/** Path the capability cookie is scoped to - it opens nothing else. */
export function devPreviewCookiePath(projectId: string, port: number): string {
  return `/api/projects/${encodeURIComponent(projectId)}/dev-preview/${port}/`;
}

/** Sign claims. Returns null when no secret is configured (fail closed). */
export function signDevPreviewToken(c: DevPreviewClaims, env: Record<string, string | undefined> = process.env): string | null {
  const s = secret(env);
  if (!s) return null;
  const body = Buffer.from(JSON.stringify([c.projectId, c.port, c.userId, c.workspaceId, c.exp])).toString("base64url");
  return `${body}.${mac(s, body)}`;
}

/** Verify a cookie value for THIS project+port. Returns claims or null. */
export function verifyDevPreviewToken(
  value: string | undefined,
  projectId: string,
  port: number,
  env: Record<string, string | undefined> = process.env,
): DevPreviewClaims | null {
  const s = secret(env);
  if (!s || !value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expect = mac(s, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const [p, pt, u, w, exp] = JSON.parse(Buffer.from(body, "base64url").toString()) as [string, number, string, string, number];
    if (p !== projectId || pt !== port) return null;
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
    return { projectId: p, port: pt, userId: u, workspaceId: w, exp };
  } catch {
    return null;
  }
}

/** The Set-Cookie header value for an issued capability. */
export function devPreviewSetCookie(token: string, projectId: string, port: number): string {
  return `${DEV_PREVIEW_COOKIE}=${token}; Path=${devPreviewCookiePath(projectId, port)}; Max-Age=${DEV_PREVIEW_TOKEN_TTL_SECONDS}; HttpOnly; Secure; SameSite=None`;
}
