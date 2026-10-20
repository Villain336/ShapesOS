// ShapesOS — how the second factor shapes the Auth.js JWT (Phase 4a).
//
// Pure functions (no Auth.js, no DB) used by the jwt/session callbacks in
// auth.ts, so the "not fully authenticated until the second factor passes"
// rule is unit-testable.
//
// Token states:
//   full     token.sub = user id. Every server-side guard (requireUser → auth()
//            → session.user.id, the dashboard layout, pages checking
//            session.user, the proxy's getToken().sub) treats this as signed in.
//   pending  first factor passed, second factor outstanding: token.sub is
//            ABSENT and the subject lives in token.mfaPendingSub (with a
//            10-minute expiry). The session callback then exposes NO user, so
//            every guard sees "not signed in" — fail closed by construction,
//            no guard needs to know 2FA exists. Only the two-factor / passkey
//            credentials providers read mfaPendingSub, to finish sign-in.
//
// token.amr lists how this session authenticated ("pwd", "sso", "email",
// "otp", "recovery", "passkey"); token.mfaAt is when a second factor (or a passkey,
// which is multi-factor on its own: possession + user verification) last
// passed. It drives the workspace "require 2FA" policy and the re-auth window
// for sensitive account changes.

export const PENDING_TTL_SECONDS = 10 * 60;
/** Sensitive account changes need a second factor this recent (or a code). */
export const REAUTH_WINDOW_SECONDS = 10 * 60;

export const TWO_FACTOR_PROVIDER_ID = "two-factor";
export const PASSKEY_PROVIDER_ID = "passkey";
/** Phase 6: email accounts — password, and one-time email link (verify / magic link). */
export const EMAIL_PASSWORD_PROVIDER_ID = "email-password";
export const EMAIL_LINK_PROVIDER_ID = "email-link";

export type AuthMethod = "pwd" | "sso" | "otp" | "recovery" | "passkey" | "email";
export type SecondFactorMethod = "otp" | "recovery" | "passkey";

export interface MfaTokenFields {
  sub?: string;
  mfaPendingSub?: string;
  mfaPendingExp?: number;
  /** Second factors the pending user can use ("totp", "passkey"). */
  mfaMethods?: string[];
  amr?: AuthMethod[];
  mfaAt?: number;
  /** Unix seconds of the sign-in that produced this session (account-deletion cutoff). */
  authAt?: number;
  /** Phase 18.3 (WS=trust): this session's user_sessions row (lib/auth/sessions.ts). */
  sid?: string;
  [key: string]: unknown;
}

export interface FactorSummary {
  totp: boolean;
  passkeys: number;
}

export function hasSecondFactor(f: FactorSummary): boolean {
  return f.totp || f.passkeys > 0;
}

export function firstFactorMethod(provider: string): AuthMethod {
  if (provider === "credentials" || provider === EMAIL_PASSWORD_PROVIDER_ID) return "pwd";
  if (provider === EMAIL_LINK_PROVIDER_ID) return "email";
  return "sso";
}

/**
 * Apply a completed sign-in to the fresh token Auth.js hands the jwt callback.
 *  - passkey provider: fully signed in; counts as multi-factor.
 *  - two-factor provider: the second step finished; fully signed in.
 *  - any first-factor provider: fully signed in when the user has no second
 *    factor, otherwise PENDING (sub removed).
 */
export function applySignIn<T extends MfaTokenFields>(
  token: T,
  opts: {
    userId: string;
    provider: string;
    factors: FactorSummary;
    nowSec: number;
    /** From the two-factor provider's authorize(): which method passed. */
    secondFactor?: SecondFactorMethod;
    /** From the two-factor provider: how the pending session started. */
    firstFactor?: AuthMethod;
  },
): T & MfaTokenFields {
  const t: T = { ...token };
  t.authAt = opts.nowSec;
  delete t.mfaPendingSub;
  delete t.mfaPendingExp;
  delete t.mfaMethods;
  delete t.mfaAt;
  if (opts.provider === PASSKEY_PROVIDER_ID) {
    t.sub = opts.userId;
    t.amr = ["passkey"];
    t.mfaAt = opts.nowSec;
    return t;
  }
  if (opts.provider === TWO_FACTOR_PROVIDER_ID) {
    t.sub = opts.userId;
    t.amr = [...(opts.firstFactor ? [opts.firstFactor] : []), opts.secondFactor ?? "otp"];
    t.mfaAt = opts.nowSec;
    return t;
  }
  const first = firstFactorMethod(opts.provider);
  if (hasSecondFactor(opts.factors)) {
    delete t.sub;
    t.mfaPendingSub = opts.userId;
    t.mfaPendingExp = opts.nowSec + PENDING_TTL_SECONDS;
    t.mfaMethods = [...(opts.factors.totp ? ["totp"] : []), ...(opts.factors.passkeys > 0 ? ["passkey"] : [])];
    t.amr = [first];
    return t;
  }
  t.sub = opts.userId;
  t.amr = [first];
  return t;
}

/** The subject waiting on its second factor, or null (none / expired). */
export function pendingSubject(token: MfaTokenFields | null | undefined, nowSec: number): string | null {
  if (!token || token.sub) return null;
  if (typeof token.mfaPendingSub !== "string" || !token.mfaPendingSub) return null;
  if (typeof token.mfaPendingExp !== "number" || token.mfaPendingExp <= nowSec) return null;
  return token.mfaPendingSub;
}

/** The fully authenticated subject, or null. */
export function fullSubject(token: MfaTokenFields | null | undefined): string | null {
  return token && typeof token.sub === "string" && token.sub ? token.sub : null;
}

/** Did this session pass a second factor (or a passkey)? */
export function sessionHasSecondFactor(token: MfaTokenFields | null | undefined): boolean {
  return !!fullSubject(token) && typeof token?.mfaAt === "number";
}

export interface SessionUserMfa {
  id: string;
  /** This session passed a second factor (TOTP, recovery code or passkey). */
  twoFactor: boolean;
  /** Unix seconds of the last second-factor check, when any. */
  mfaAt: number | null;
  /** Unix seconds this session signed in; null for sessions minted before Phase 4a. */
  authAt: number | null;
}

/**
 * What the session callback exposes. A pending token yields NO user (so
 * every guard reads it as signed out) plus a `mfa` marker for the login page.
 */
export function sessionView(
  token: MfaTokenFields,
  nowSec: number,
): { user: SessionUserMfa | null; mfa: { pending: true; methods: string[] } | null } {
  const sub = fullSubject(token);
  if (sub) {
    return {
      user: {
        id: sub,
        twoFactor: sessionHasSecondFactor(token),
        mfaAt: typeof token.mfaAt === "number" ? token.mfaAt : null,
        authAt: typeof token.authAt === "number" ? token.authAt : null,
      },
      mfa: null,
    };
  }
  if (pendingSubject(token, nowSec)) {
    return { user: null, mfa: { pending: true, methods: Array.isArray(token.mfaMethods) ? token.mfaMethods : [] } };
  }
  return { user: null, mfa: null };
}

/** A second factor passed within the re-auth window. */
export function recentlyVerified(mfaAt: number | null | undefined, nowSec: number): boolean {
  return typeof mfaAt === "number" && nowSec - mfaAt <= REAUTH_WINDOW_SECONDS;
}
