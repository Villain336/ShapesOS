// Marketr — Auth.js (NextAuth v5) configuration (spec §11 tech approach).
//
// Providers:
//   - Google OAuth (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
//   - Credentials — self-hosted admin login from ADMIN_EMAIL / ADMIN_PASSWORD.
//     No password hashing: the credential lives in the operator's .env,
//     never in the database. For the hosted SaaS this gets replaced by a
//     proper user store; milestone 2 is the in-house beta.
//
// The session user's id is the identity wired to Workspace.ownerUserId
// (see lib/session.ts).

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt" },
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
  ],
  callbacks: {
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
