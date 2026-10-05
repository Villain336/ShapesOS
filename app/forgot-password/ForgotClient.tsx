"use client";

// ShapesOS — forgot password (Phase 6). Always the same answer, whether or
// not the address has an account; the CAPTCHA only appears when the server
// asks for it (step-up after repeated failures).

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Field, FieldMessage, aosButton } from "@/components/aos";
import { AuthShell, SentNotice } from "@/components/auth/AuthShell";
import { postEmailAuth } from "@/components/auth/client";
import { CaptchaWidget, type CaptchaPublicConfig } from "@/components/security/CaptchaWidget";

export default function ForgotClient({ captcha, enabled }: { captcha: CaptchaPublicConfig | null; enabled: boolean }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEmailError(null);
    setBusy(true);
    try {
      const res = await postEmailAuth("password/forgot", { email, ...(captchaToken ? { captchaToken } : {}) });
      if (res.ok) {
        setSent(res.message);
        return;
      }
      if (res.code === "captcha_required" && captcha) {
        setNeedCaptcha(true);
        setCaptchaKey((k) => k + 1);
      }
      if (res.code === "invalid_email") setEmailError(res.message);
      else setError(res.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      {!enabled ? (
        <>
          <h1 className="aos-heading">Password reset isn&apos;t available</h1>
          <p className="mt-2 text-sm text-muted">Email isn&apos;t configured on this server, so reset links can&apos;t be sent.</p>
          <Link href="/login" className={aosButton({ variant: "secondary", className: "mt-6 w-full" })}>
            Go to sign in
          </Link>
        </>
      ) : sent ? (
        <SentNotice title="Check your email" message={sent}>
          <Link href="/login" className={aosButton({ variant: "secondary", className: "mt-2 w-full" })}>
            Back to sign in
          </Link>
        </SentNotice>
      ) : (
        <>
          <h1 className="aos-heading">Reset your password</h1>
          <p className="mt-1 text-sm text-muted">We&apos;ll email you a link to choose a new password.</p>
          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={emailError}
            />
            {needCaptcha && captcha && <CaptchaWidget config={captcha} onToken={setCaptchaToken} resetKey={captchaKey} />}
            <FieldMessage id="forgot-error" error={error} />
            <button
              type="submit"
              disabled={busy || !email.trim() || (needCaptcha && !!captcha && !captchaToken)}
              className={aosButton({ className: "w-full" })}
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 aos-spin" aria-hidden="true" />
                  Sending
                </>
              ) : (
                "Email me a reset link"
              )}
            </button>
          </form>
          <p className="mt-5 text-center text-sm text-muted">
            <Link href="/login" className="font-semibold text-ink underline-offset-2 hover:underline">
              Back to sign in
            </Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}
