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
    ...extraProviders,
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
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
        } catch (err) {
          console.error("[sso] auto-provisioning failed:", err);
        }
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
  pages: { signIn: "/login" },
});
