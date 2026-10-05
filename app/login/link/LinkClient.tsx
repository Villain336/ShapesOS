"use client";

// ShapesOS — redeem an emailed verify / magic link through the "email-link"
// Credentials provider (Phase 6). A session that still needs its second
// factor continues on /login (it shows the second step for pending sessions).

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { FieldMessage, aosButton } from "@/components/aos";
import { AuthShell } from "@/components/auth/AuthShell";
import { useLinkToken } from "@/components/auth/client";
import { fetchAuthState } from "@/components/security/client";

const ERRORS: Record<string, string> = {
  link_invalid: "This link has already been used or has expired. Ask for a new one from the sign-in page.",
  locked: "Too many attempts. Wait a while, then try again.",
};

export default function LinkClient() {
  const token = useLinkToken();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onContinue() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await signIn("email-link", { token, redirect: false, callbackUrl: "/dashboard" });
      if (res?.error) {
        if (res.code === "invite_required") {
          window.location.href = "/invite-required";
          return;
        }
        setError(ERRORS[res.code ?? ""] ?? ERRORS.link_invalid!);
        return;
      }
      const state = await fetchAuthState();
      if (state.pending) {
        window.location.href = "/login";
        return;
      }
      window.location.href = state.signedIn ? "/dashboard" : "/invite-required";
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="aos-heading">Sign in to ShapesOS</h1>
      {token === null ? (
        <>
          <p className="mt-2 text-sm text-muted">This link is missing its code. Open the link from your email again, or ask for a new one.</p>
          <Link href="/login" className={aosButton({ variant: "secondary", className: "mt-6 w-full" })}>
            Go to sign in
          </Link>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted">Continue to confirm your email and sign in. The link works once.</p>
          <button type="button" onClick={onContinue} disabled={!token || busy || !!error} className={aosButton({ className: "mt-6 w-full" })}>
            {busy ? <Loader2 className="size-4 aos-spin" aria-hidden="true" /> : <LogIn className="size-4" aria-hidden="true" />}
            {busy ? "Signing in" : "Continue"}
          </button>
          {error && (
            <div className="mt-4 flex flex-col gap-3">
              <FieldMessage id="link-error" error={error} />
              <Link href="/login" className={aosButton({ variant: "secondary", className: "w-full" })}>
                Back to sign in
              </Link>
            </div>
          )}
        </>
      )}
    </AuthShell>
  );
}
