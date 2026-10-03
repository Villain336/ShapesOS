import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      /** Phase 4a: this session passed a second factor (TOTP, recovery code or passkey). */
      twoFactor?: boolean;
      /** Unix seconds this session signed in (first or second factor). */
      authAt?: number | null;
      /** Phase 4a: unix seconds of the last second-factor check (re-auth window). */
      mfaAt?: number | null;
    } & DefaultSession["user"];
    /** Phase 4a: set (and `user` absent) while a sign-in waits on its second factor. */
    mfa?: { pending: true; methods: string[] } | null;
  }
}
