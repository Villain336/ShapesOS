// ShapesOS — Funding data room: viewer email verification (Phase 1).
//
// Allowlisted share links used to trust a self-asserted `?email=`: anyone
// holding the link who knew (or guessed) an investor's address got in and
// was logged AS that investor. Now:
//
//   1. The viewer enters an email. If it is on the link's allowlist, a
//      single-purpose MAGIC LINK (HMAC-signed, 15 min) is emailed to that
//      address. The page says the same thing either way — no allowlist
//      oracle.
//   2. Opening the magic link sets an HttpOnly SESSION cookie scoped to the
//      share link's path (HMAC-signed; ≤12 h and never past the link's own
//      expiry), then redirects to the clean URL (the token leaves the bar).
//   3. Every request re-verifies the cookie AND re-checks the allowlist, so
//      removing an investor or revoking/expiring the link cuts access.
//
// Stateless (no schema change): tokens are bound to the link id, the
// purpose ("magic" vs "session") and an expiry, keyed off AUTH_SECRET via a
// purpose-specific derived key. No secret configured → verification is
// unavailable and allowlisted links fail closed.

import { createHmac, timingSafeEqual } from "node:crypto";

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const VIEWER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const VIEWER_COOKIE = "fdr_viewer";
/** One magic-link email per (link, address) per window. */
export const MAGIC_LINK_RESEND_MS = 60 * 1000;

type Purpose = "magic" | "session";

interface TokenPayload {
  l: string; // share link id
  e: string; // verified email (lowercased)
  x: number; // expiry, epoch ms
  p: Purpose;
}

/** Secret for viewer tokens; null when unconfigured (fail closed). */
export function viewerSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.AUTH_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim();
  return s || null;
}

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("shapes:funding-dataroom-viewer:v1").digest();
}

function mac(secret: string, body: string): string {
  return createHmac("sha256", key(secret)).update(body).digest("base64url");
}

export function signViewerToken(
  input: { linkId: string; email: string; expiresAt: number; purpose: Purpose },
  secret: string,
): string {
  const payload: TokenPayload = {
    l: input.linkId,
    e: input.email.trim().toLowerCase(),
    x: Math.floor(input.expiresAt),
    p: input.purpose,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

/** Verified email for `token`, or null (bad signature, wrong link/purpose, expired). */
export function verifyViewerToken(
  token: string | null | undefined,
  expect: { linkId: string; purpose: Purpose; now: number },
  secret: string,
): { email: string; expiresAt: number } | null {
  if (!token || token.length > 2048) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let p: TokenPayload;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
  if (!p || typeof p !== "object") return null;
  if (p.l !== expect.linkId || p.p !== expect.purpose) return null;
  if (typeof p.e !== "string" || !p.e || typeof p.x !== "number") return null;
  if (p.x <= expect.now) return null;
  return { email: p.e, expiresAt: p.x };
}

export interface ViewerLink {
  id: string;
  expiresAt: Date | null;
  viewerEmails: string[];
}

export type ViewerAccess =
  /** Link has no allowlist: anyone with the link may view (as before). */
  | { kind: "open" }
  /** Verified viewer (session cookie). */
  | { kind: "granted"; email: string }
  /** Valid magic link: set the session cookie, redirect to the clean URL. */
  | { kind: "start-session"; email: string; cookieValue: string; maxAgeSeconds: number }
  /** Viewer submitted an address: email a link if allowlisted, then say "check your email". */
  | { kind: "send-link"; email: string; magicToken: string | null }
  /** Show the email form (optionally with a notice). */
  | { kind: "email-form"; notice?: "link_invalid" }
  /** Allowlisted link, but no secret is configured: fail closed. */
  | { kind: "unavailable" };

function isAllowlisted(link: ViewerLink, email: string): boolean {
  const e = email.trim().toLowerCase();
  return !!e && link.viewerEmails.some((v) => v.trim().toLowerCase() === e);
}

const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}$/;

/**
 * Decide what an anonymous request to an (unrevoked, unexpired) share link
 * gets. Pure: the route does the I/O (cookie, email, redirect).
 */
export function resolveViewerAccess(input: {
  link: ViewerLink;
  query: { email?: string | null; verify?: string | null };
  sessionCookie: string | null;
  now: number;
  secret: string | null;
}): ViewerAccess {
  const { link, query, sessionCookie, now, secret } = input;
  if (link.viewerEmails.length === 0) return { kind: "open" };
  if (!secret) return { kind: "unavailable" };

  if (query.verify) {
    const v = verifyViewerToken(query.verify, { linkId: link.id, purpose: "magic", now }, secret);
    if (!v || !isAllowlisted(link, v.email)) return { kind: "email-form", notice: "link_invalid" };
    const cap = link.expiresAt ? Math.min(link.expiresAt.getTime(), now + VIEWER_SESSION_TTL_MS) : now + VIEWER_SESSION_TTL_MS;
    const cookieValue = signViewerToken({ linkId: link.id, email: v.email, expiresAt: cap, purpose: "session" }, secret);
    return {
      kind: "start-session",
      email: v.email,
      cookieValue,
      maxAgeSeconds: Math.max(1, Math.floor((cap - now) / 1000)),
    };
  }

  const session = verifyViewerToken(sessionCookie, { linkId: link.id, purpose: "session", now }, secret);
  if (session && isAllowlisted(link, session.email)) return { kind: "granted", email: session.email };

  const asked = query.email?.trim().toLowerCase() ?? "";
  if (asked && EMAIL_RE.test(asked)) {
    const magicToken = isAllowlisted(link, asked)
      ? signViewerToken({ linkId: link.id, email: asked, expiresAt: now + MAGIC_LINK_TTL_MS, purpose: "magic" }, secret)
      : null;
    return { kind: "send-link", email: asked, magicToken };
  }
  return { kind: "email-form" };
}

/** In-process resend throttle: true when a link email may be sent now. */
const lastSent = new Map<string, number>();
export function mayResendMagicLink(linkId: string, email: string, now: number): boolean {
  const k = `${linkId}|${email}`;
  const prev = lastSent.get(k) ?? 0;
  if (now - prev < MAGIC_LINK_RESEND_MS) return false;
  lastSent.set(k, now);
  if (lastSent.size > 10_000) {
    for (const [kk, t] of lastSent) if (now - t >= MAGIC_LINK_RESEND_MS) lastSent.delete(kk);
  }
  return true;
}

/** Absolute app origin for emailed links — configured, never the Host header. */
export function appOriginForLinks(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.MARKETR_BASE_URL ?? "").trim() || (env.NEXTAUTH_URL ?? "").trim() || (env.AUTH_URL ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}
