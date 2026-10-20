// ShapesOS — Phase 18.3 (WS=trust): the session registry, pure half.
//
// Auth stays JWT (auth.ts, strategy "jwt"). What 18.3 adds, without changing
// that strategy: each completed sign-in writes one user_sessions row and puts
// its id in the token as `sid`; the jwt callback then asks the registry about
// that id on every session read and REFUSES the token once the row is revoked
// (Auth.js clears the cookie when the jwt callback returns null). Signing a
// session out is therefore "revoke its row" — it ends that browser on its
// next request and leaves every other browser alone.
//
// Tokens minted before 18.3 carry no sid. "Sign out other sessions" covers
// them too: it stamps a per-person cutoff row (LEGACY_ROW_PREFIX + userId,
// revoked_at = the cutoff) and a token with no sid that signed in before the
// cutoff is refused. The cutoff row is bookkeeping, never listed.
//
// This file is client-safe and pure (no Prisma): the claim decision, the
// device label (from the user agent) and the IP prefix (never the full IP).

/** Touch last_seen_at at most this often per session. */
export const SESSION_TOUCH_MS = 5 * 60_000;
/** Id of the per-person cutoff row for tokens that predate the registry. */
export const LEGACY_ROW_PREFIX = "legacy:";

export function legacyRowId(userId: string): string {
  return `${LEGACY_ROW_PREFIX}${userId}`;
}

/** What the registry knows about one token's session. */
export type SessionRowState =
  | { kind: "row"; revokedAt: Date | null; expiresAt: Date }
  | { kind: "missing" }
  | { kind: "legacy"; cutoff: Date | null };

export type ClaimDecision = "allow" | "reject";

/**
 * Should this token's session still be honoured? PURE.
 *   - a token with no subject (signed out / pending second factor) is not
 *     the registry's business: allow (the MFA state machine handles it);
 *   - a token with a sid: allowed while its row exists, is not revoked and
 *     has not passed its absolute expiry; a MISSING row is refused (the row
 *     was deleted with the account, or the sid was forged into a token we
 *     signed — impossible without AUTH_SECRET — either way, no);
 *   - a token without a sid (signed in before 18.3): allowed unless the
 *     person signed out other sessions after it signed in.
 */
export function sessionClaimDecision(
  token: { sub?: unknown; sid?: unknown; authAt?: unknown },
  state: SessionRowState,
  now: Date,
): ClaimDecision {
  if (typeof token.sub !== "string" || !token.sub) return "allow";
  if (typeof token.sid === "string" && token.sid) {
    if (state.kind !== "row") return "reject";
    if (state.revokedAt) return "reject";
    if (state.expiresAt.getTime() <= now.getTime()) return "reject";
    return "allow";
  }
  if (state.kind !== "legacy" || !state.cutoff) return "allow";
  const authAtMs = typeof token.authAt === "number" ? token.authAt * 1000 : 0;
  return authAtMs >= state.cutoff.getTime() ? "allow" : "reject";
}

/** Is it time to write last_seen_at again? PURE. */
export function shouldTouch(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() >= SESSION_TOUCH_MS;
}

/** "203.0.113.0/24", "2001:db8:1::/48" — never the full address. PURE. */
export function ipPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.trim().replace(/^::ffff:/i, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) {
    const parts = v4.slice(1, 4).map(Number);
    if (parts.some((n) => n > 255)) return null;
    return `${parts.join(".")}.0/24`;
  }
  if (v.includes(":") && /^[0-9a-f:]+$/i.test(v)) {
    // Expand "::" enough to take the first three groups.
    const [head = "", tail = ""] = v.split("::");
    const headGroups = head ? head.split(":") : [];
    const tailGroups = tail ? tail.split(":") : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    const groups = v.includes("::") ? [...headGroups, ...Array(Math.max(missing, 0)).fill("0"), ...tailGroups] : headGroups;
    if (groups.length !== 8) return null;
    const first = groups.slice(0, 3).map((g) => (g.replace(/^0+/, "") || "0").toLowerCase());
    return `${first.join(":")}::/48`;
  }
  return null;
}

/** "Chrome on macOS", "Safari on iPhone", "ShapesOS app on Android". PURE. */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  const ua = (userAgent ?? "").trim();
  if (!ua) return null;
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  const browser = /Expo|okhttp|CFNetwork|ShapesOS/i.test(ua) && !/Mozilla/.test(ua)
    ? "ShapesOS app"
    : /Edg\//.test(ua)
      ? "Edge"
      : /OPR\/|Opera/.test(ua)
        ? "Opera"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : /HeadlessChrome|Playwright/.test(ua)
                ? "Chrome"
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 60);
}
