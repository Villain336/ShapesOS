"use client";

// ShapesOS — set a new password with a single-use reset link (Phase 6).
// POST /api/auth/email/password/reset; success voids every other link for
// the address. The person then signs in normally (second factor included).

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Field, FieldMessage, aosButton } from "@/components/aos";
import { AuthShell, SentNotice } from "@/components/auth/AuthShell";
import { postEmailAuth, useLinkToken } from "@/components/auth/client";

export default function ResetClient() {
  const token = useLinkToken();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setConfirmError(null);
    setError(null);
    if (password !== confirm) {
      setConfirmError("The passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await postEmailAuth("password/reset", { token, password });
      if (res.ok) {
        setDone(res.message);
        return;
      }
      if (res.code === "weak_password") setPasswordError(res.message);
      else setError(res.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthShell>
        <SentNotice title="Password changed" message={done} icon={KeyRound}>
          <Link href="/login" className={aosButton({ className: "mt-2 w-full" })}>
            Sign in
          </Link>
        </SentNotice>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="aos-heading">Choose a new password</h1>
      {token === null ? (
        <>
          <p className="mt-2 text-sm text-muted">This link is missing its code. Open the link from your email again, or ask for a new one.</p>
          <Link href="/forgot-password" className={aosButton({ variant: "secondary", className: "mt-6 w-full" })}>
            Ask for a new link
          </Link>
        </>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            helper="At least 10 characters. Avoid common passwords."
            error={passwordError}
          />
          <Field
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={confirmError}
          />
          <FieldMessage id="reset-error" error={error} />
          {error && (
            <Link href="/forgot-password" className="text-sm font-semibold text-ink underline-offset-2 hover:underline">
              Ask for a new link
            </Link>
          )}
          <button type="submit" disabled={busy || !token || !password || !confirm} className={aosButton({ className: "w-full" })}>
            {busy ? (
              <>
                <Loader2 className="size-4 aos-spin" aria-hidden="true" />
                Saving
              </>
            ) : (
              "Set new password"
            )}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
