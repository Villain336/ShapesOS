// Marketr — Auth.js (NextAuth v5) configuration (spec §11 tech approach).
//
// Providers:
//   - Google OAuth (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
//   - Credentials — self-hosted admin login from ADMIN_EMAIL / ADMIN_PASSWORD.
//     No password hashing: the credential lives in the operator's .env,
//     never in the database. For the hosted SaaS this gets replaced by a
//     proper user store; milestone 2 is the in-house beta.
//   - Generic OIDC (milestone 11) — any OIDC-compliant IdP (Okta, Entra ID,
//     Google Workspace, Keycloak, Authentik). Enabled when OIDC_ISSUER,
//     OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are set.
//   - SAML via BoxyHQ (milestone 11) — enabled when SAML_ENABLED=true.
//     Requires a BoxyHQ SAML Jackson deployment as the protocol bridge
//     (open-source, self-hostable: https://boxyhq.com/docs/jackson/deploy).
//     Set BOXYHQ_SAML_ISSUER to your Jackson URL.
//
// SSO auto-provisioning (milestone 11): when SSO_WORKSPACE_ID + SSO_DOMAIN
// are set, users signing in via OIDC/SAML whose email domain matches are
// added to that workspace (SSO_DEFAULT_ROLE, default "editor").
//
// Session hardening (milestone 11): absolute 12h JWT lifetime.
//
// Phase 4a (identity):
//   - Second factor: users with TOTP or a passkey get a PENDING token after
//     the first factor (no token.sub → every guard reads "signed out") until
//     the "two-factor" or "passkey" credentials provider finishes sign-in
//     (lib/auth/mfa/session-token.ts has the state machine).
//   - Passkeys: usernameless sign-in through the "passkey" provider.
//   - Stable OAuth subjects: without a database adapter Auth.js mints a
//     RANDOM user id on every OAuth/OIDC/SAML sign-in, so the same person got
//     a new identity (and memberships, 2FA, passkeys keyed on it never
//     matched) each time. The subject is now "<provider>:<providerAccountId>".
//   - CAPTCHA step-up on the credentials login after repeated failures
//     (lib/auth/captcha.ts; no-op unless a provider is configured).

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import BoxyHQSAML from "next-auth/providers/boxyhq-saml";
import type { Provider } from "next-auth/providers";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "./lib/prisma";
import { provisionSsoUser } from "./lib/sso";

// ---------------------------------------------------------------------------
// Day-1 hardening (H1/M8): brute-force protection on the credentials login.
// See lib/auth/rate-limit.ts — two independent dimensions (per-IP across
// accounts, per-account across IPs), in-memory, single-instance by design.
// ---------------------------------------------------------------------------
import {
  loginLockedOut,
  recordLoginFailure,
  recordLoginSuccess,
} from "./lib/auth/rate-limit";
import { clientIpFromHeaders } from "./lib/api/client-ip";
import { INVITE_REQUIRED_PATH, signInAllowed, signupMode } from "./lib/auth/signup";
import { CredentialsSignin, type Session } from "next-auth";
import { captchaRequired, verifyCaptchaToken } from "./lib/auth/captcha";
import { authorizePasskey, authorizeTwoFactor, type MfaSignInMarker } from "./lib/auth/mfa/authorize";
import {
  PASSKEY_PROVIDER_ID,
  TWO_FACTOR_PROVIDER_ID,
  applySignIn,
  sessionView,
  type FactorSummary,
} from "./lib/auth/mfa/session-token";
import { factorSummary } from "./lib/auth/mfa/store";
import { linkScimMembersOnSsoLogin } from "./lib/scim/link";

/** The CAPTCHA step-up is due and the attempt carried no valid token. */
class CaptchaRequiredError extends CredentialsSignin {
  code = "captcha_required";
}

/** Account types whose user id Auth.js would otherwise randomize per sign-in. */
const OAUTH_LIKE = new Set(["oauth", "oidc"]);

/** "provider:providerAccountId", the stable subject for OAuth/OIDC/SAML users. */
function stableOauthSubject(account: { provider: string; providerAccountId: string; type: string }): string | null {
  if (!OAUTH_LIKE.has(account.type) || !account.providerAccountId) return null;
  return account.provider + ":" + account.providerAccountId;
}

function clientIp(req: Request | undefined): string | null {
  return clientIpFromHeaders(req?.headers);
}

/** Timing-safe string comparison via SHA-256 (handles variable lengths). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return ha.length === hb.length && timingSafeEqual(ha, hb);
}

async function auditAuthEvent(
  action: "auth_login_failed" | "auth_login_succeeded",
  summary: string,
): Promise<void> {
  try {
    await prisma.fileChangeLog.create({
      data: {
        projectId: null,
        workspaceId: null,
        filePath: "(auth)",
        actor: "system",
        action,
        summary,
      },
    });
  } catch (err) {
    // Explicit day-1 decision: audit writes are fail-OPEN here. This is the
    // self-hosted admin login — a database outage must not lock the operator
    // out of their own instance (they need to sign in to diagnose the DB).
    // The console line preserves a local trace of the audit gap.
    console.error("[auth] audit write failed:", err);
  }
}

function oidcProvider(): Provider | null {
  const issuer = (process.env.OIDC_ISSUER ?? "").trim();
  const clientId = (process.env.OIDC_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.OIDC_CLIENT_SECRET ?? "").trim();
  if (!issuer || !clientId || !clientSecret) return null;
  // Generic OIDC — Auth.js discovers endpoints from the issuer's
  // .well-known/openid-configuration. Works with Okta, Entra ID,
  // Google Workspace, Keycloak, Authentik, or any OIDC-compliant IdP.
  // NOTE: not live-verified in this sandbox (no IdP available); configured
  // against the documented Auth.js v5 OIDC provider shape.
  return {
    id: "oidc",
    name: process.env.OIDC_DISPLAY_NAME?.trim() || "SSO",
    type: "oidc",
    issuer,
    clientId,
    clientSecret,
    authorization: { params: { scope: "openid email profile" } },
  } as Provider;
}

function samlProvider(): Provider | null {
  if ((process.env.SAML_ENABLED ?? "").trim().toLowerCase() !== "true") return null;
  const issuer = (process.env.BOXYHQ_SAML_ISSUER ?? "").trim();
  const clientId = (process.env.BOXYHQ_SAML_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.BOXYHQ_SAML_CLIENT_SECRET ?? "").trim();
  if (!issuer || !clientId || !clientSecret) return null;
  return BoxyHQSAML({
    // OAuth 2.0 flow against the Jackson bridge (empty scope per BoxyHQ docs).
    authorization: { params: { scope: "" } },
    clientId,
    clientSecret,
    issuer,
  });
}

const extraProviders: Provider[] = [];
const oidc = oidcProvider();
if (oidc) extraProviders.push(oidc);
const saml = samlProvider();
if (saml) extraProviders.push(saml);

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt",
    // Absolute session lifetime: 12h. Re-auth required after that.
    maxAge: 12 * 60 * 60,
  },
  providers: [
    Google,
    Credentials({
      name: "Admin",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        // Phase 4a: CAPTCHA step-up token (only checked once it's due).
        captchaToken: { label: "CAPTCHA", type: "hidden" },
      },
      async authorize(credentials, req) {
        const email = String(credentials?.email ?? "")
          .trim()
          .toLowerCase();
        const password = String(credentials?.password ?? "");
        const adminEmail = (process.env.ADMIN_EMAIL ?? "")
          .trim()
          .toLowerCase();
        const adminPassword = process.env.ADMIN_PASSWORD ?? "";
        const ip = clientIp(req as Request | undefined);

        // Fail closed under lockout: don't even compare the password.
        if (loginLockedOut(ip, email || "unknown")) {
          console.warn(`[auth] login blocked (rate limit): ${email || "unknown"} from ${ip ?? "unknown ip"}`);
          return null;
        }
        // Phase 4a step-up: after N failures a CAPTCHA must pass first
        // (no-op without CAPTCHA_PROVIDER; see lib/auth/captcha.ts).
        if (captchaRequired(ip, email || "unknown")) {
          const captchaToken = typeof credentials?.captchaToken === "string" ? credentials.captchaToken : "";
          if (!(await verifyCaptchaToken(captchaToken, ip))) throw new CaptchaRequiredError();
        }
        if (!adminEmail || !adminPassword || !email) {
          if (email) {
            recordLoginFailure(ip, email);
            await auditAuthEvent("auth_login_failed", `login failed for ${email} (no admin credential configured)`);
          }
          return null;
        }
        if (safeEqual(email, adminEmail) && safeEqual(password, adminPassword)) {
          recordLoginSuccess(ip, email);
          await auditAuthEvent("auth_login_succeeded", `admin login succeeded for ${email} from ${ip ?? "unknown ip"}`);
          return {
            id: `admin:${adminEmail}`,
            name: "Admin",
            email: adminEmail,
          };
        }
        recordLoginFailure(ip, email);
        await auditAuthEvent(
          "auth_login_failed",
          `login failed for ${email} from ${ip ?? "unknown ip"}`,
        );
        return null;
      },
    }),
    // Phase 4a: second step of a pending sign-in (TOTP / recovery code /
    // enrollment proof). The subject comes from the caller's own pending
    // session cookie, never from the form.
    Credentials({
      id: TWO_FACTOR_PROVIDER_ID,
      name: "Two-factor",
      credentials: { code: { label: "Code", type: "text" }, proof: { label: "Proof", type: "text" } },
      authorize: (credentials, req) => authorizeTwoFactor(credentials ?? {}, req as Request),
    }),
    // Phase 4a: passkey (WebAuthn) sign-in: usernameless, also completes a
    // pending sign-in or re-authenticates.
    Credentials({
      id: PASSKEY_PROVIDER_ID,
      name: "Passkey",
      credentials: { challengeId: { label: "Challenge", type: "text" }, response: { label: "Response", type: "text" } },
      authorize: (credentials, req) => authorizePasskey(credentials ?? {}, req as Request),
    }),
    ...extraProviders,
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      // Phase 4a: pin OAuth/OIDC/SAML users to a stable subject BEFORE anything
      // keys on user.id (Auth.js hands this same object to the jwt callback).
      if (user && account) {
        const stable = stableOauthSubject(account);
        if (stable) user.id = stable;
      }
      // SSO provisioning: optional domain-based workspace auto-provisioning.
      // Runs at login time only, and only with a VERIFIED email claim
      // (day-1 hardening, M4) — a lax IdP asserting someone else's address
      // must not walk into the workspace.
      if (
        user?.id &&
        user.email &&
        account &&
        (account.provider === "oidc" || account.provider === "boxyhq-saml")
      ) {
        try {
          const emailVerified =
            (profile as { email_verified?: unknown } | null)?.email_verified === true;
          await provisionSsoUser(user.id, user.email, emailVerified);
          // Phase 4a: SCIM-provisioned members of any workspace are linked to
          // this SSO identity (verified email only; see lib/scim/link.ts).
          await linkScimMembersOnSsoLogin(user.id, user.email, emailVerified);
        } catch (err) {
          console.error("[sso] auto-provisioning failed:", err);
        }
      }
      // Phase 1: SIGNUP_MODE=invite — brand-new users without a membership
      // or a pending invite get no session (lib/auth/signup.ts). Fails
      // closed on a DB error; the operator's credentials login never
      // touches the DB here.
      if (signupMode() === "invite") {
        try {
          if (!(await signInAllowed(user?.id, user?.email))) return INVITE_REQUIRED_PATH;
        } catch (err) {
          console.error("[auth] invite-mode sign-in check failed:", err);
          return INVITE_REQUIRED_PATH;
        }
      }
      return true;
    },
    async jwt({ token, user, account }) {
      if (!user?.id || !account) return token;
      // A sign-in just completed. Decide full vs pending (second factor).
      const marker = (user as { mfa?: MfaSignInMarker }).mfa;
      let factors: FactorSummary = { totp: false, passkeys: 0 };
      if (account.provider !== PASSKEY_PROVIDER_ID && account.provider !== TWO_FACTOR_PROVIDER_ID) {
        try {
          factors = await factorSummary(user.id);
        } catch (err) {
          // Fail CLOSED: if we can't tell whether a second factor is required,
          // the session stays pending (and can't be completed until the DB is
          // back) rather than skipping 2FA for someone who enrolled.
          console.error("[auth] second-factor lookup failed; session left pending:", err);
          factors = { totp: true, passkeys: 0 };
        }
      }
      return applySignIn(token, {
        userId: user.id,
        provider: account.provider,
        factors,
        nowSec: Math.floor(Date.now() / 1000),
        secondFactor: marker?.secondFactor,
        firstFactor: marker?.firstFactor,
      });
    },
    async session({ session, token }) {
      const view = sessionView(token, Math.floor(Date.now() / 1000));
      if (view.user && session.user) {
        session.user.id = view.user.id;
        session.user.twoFactor = view.user.twoFactor;
        session.user.mfaAt = view.user.mfaAt;
        session.user.authAt = view.user.authAt;
        return session;
      }
      // Pending second factor (or no subject): expose NO user, so every guard
      // (requireUser, pages checking session.user) treats it as signed out.
      return { expires: session.expires, mfa: view.mfa } as unknown as Session;
    },
  },
  pages: { signIn: "/login" },
});
