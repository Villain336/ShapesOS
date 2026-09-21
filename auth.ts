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
import { provisionSsoUser } from "./lib/sso";

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
      async authorize(credentials) {
        const email = String(credentials?.email ?? "")
          .trim()
          .toLowerCase();
        const password = String(credentials?.password ?? "");
        const adminEmail = (process.env.ADMIN_EMAIL ?? "")
          .trim()
          .toLowerCase();
        const adminPassword = process.env.ADMIN_PASSWORD ?? "";
        if (!adminEmail || !adminPassword) return null;
        if (email === adminEmail && password === adminPassword) {
          return {
            id: `admin:${adminEmail}`,
            name: "Admin",
            email: adminEmail,
          };
        }
        return null;
      },
    }),
    ...extraProviders,
  ],
  callbacks: {
    async signIn({ user, account }) {
      // SSO provisioning: link pending invites + optional domain-based
      // workspace auto-provisioning. Runs at login time only.
      if (
        user?.id &&
        user.email &&
        account &&
        (account.provider === "oidc" || account.provider === "boxyhq-saml")
      ) {
        try {
          await provisionSsoUser(user.id, user.email);
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
