// ShapesOS — the "Email" tab on /login (Phase 6): email + password for email
// accounts, or "Email me a sign-in link" (magic link). Sign-in goes through
// the "email-password" Credentials provider; a session that still needs its
// second factor hands back to the login page's second step.

"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Loader2, Mail } from "lucide-react";
import { Field, FieldMessage, aosButton } from "@/components/aos";
import { CaptchaWidget, type CaptchaPublicConfig } from "@/components/security/CaptchaWidget";
import { fetchAuthState } from "@/components/security/client";
import { postEmailAuth } from "@/components/auth/client";
import { SentNotice } from "@/components/auth/AuthShell";

const SIGN_IN_ERRORS: Record<string, string> = {
  locked: "Too many attempts. Wait a while, then try again.",
  email_unverified: "Confirm your email first. Use the link we sent when you signed up, or sign up again to get a new one.",
  captcha_required: "Complete the security check, then sign in again.",
};

export function EmailSignIn({
  captcha,
  next,
  onPending,
}: {
  captcha: CaptchaPublicConfig | null;
  next: string;
  onPending: (methods: string[]) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "link" | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);

  async function onPassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEmailError(null);
    setBusy("password");
    try {
      const res = await signIn("email-password", {
        email,
        password,
        ...(captchaToken ? { captchaToken } : {}),
        redirect: false,
        callbackUrl: next,
      });
      if (res?.error) {
        const code = res.code ?? "";
        if (code === "captcha_required" && captcha) setNeedCaptcha(true);
        setError(SIGN_IN_ERRORS[code] ?? "Wrong email or password.");
        if (needCaptcha || code === "captcha_required") setCaptchaKey((k) => k + 1);
        return;
      }
      const state = await fetchAuthState();
      if (state.pending) {
        onPending(state.methods);
        return;
      }
      if (!state.signedIn) {
        // The signIn callback refused the session (invite-only, no invite).
        window.location.href = "/invite-required";
        return;
      }
      window.location.href = res?.url ?? next;
    } finally {
      setBusy(null);
    }
  }

  async function onLink() {
    setError(null);
    setEmailError(null);
    if (!email.trim()) {
      setEmailError("Enter your email address first.");
      return;
    }
    setBusy("link");
    try {
      const res = await postEmailAuth("magic-link", { email, ...(captchaToken ? { captchaToken } : {}) });
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
      setBusy(null);
    }
  }

  if (sent) {
    return (
      <SentNotice title="Check your email" message={sent}>
        <button type="button" onClick={() => setSent(null)} className={aosButton({ variant: "secondary", className: "mt-2 w-full" })}>
          Use a different email
        </button>
      </SentNotice>
    );
  }

  return (
    <form onSubmit={onPassword} className="flex flex-col gap-4" noValidate>
      <Field
        label="Email"
        type="email"
        required
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={emailError}
      />
      <Field
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        helper={
          <Link href="/forgot-password" className="font-semibold text-ink underline-offset-2 hover:underline">
            Forgot password?
          </Link>
        }
      />
      {needCaptcha && captcha && <CaptchaWidget config={captcha} onToken={setCaptchaToken} resetKey={captchaKey} />}
      <FieldMessage id="email-signin-error" error={error} />
      <button
        type="submit"
        disabled={busy !== null || !email.trim() || !password || (needCaptcha && !!captcha && !captchaToken)}
        className={aosButton({ className: "w-full" })}
      >
        {busy === "password" ? (
          <>
            <Loader2 className="size-4 aos-spin" aria-hidden="true" />
            Signing in
          </>
        ) : (
          "Sign in"
        )}
      </button>
      <button
        type="button"
        onClick={onLink}
        disabled={busy !== null || (needCaptcha && !!captcha && !captchaToken)}
        className={aosButton({ variant: "secondary", className: "w-full" })}
      >
        {busy === "link" ? <Loader2 className="size-4 aos-spin" aria-hidden="true" /> : <Mail className="size-4" aria-hidden="true" />}
        {busy === "link" ? "Sending" : "Email me a sign-in link"}
      </button>
      <p className="text-center text-sm text-muted">
        New here?{" "}
        <Link href="/signup" className="font-semibold text-ink underline-offset-2 hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}
