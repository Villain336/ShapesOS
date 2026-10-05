"use client";

// ShapesOS — Phase 10 (portal): the client portal sign-in form. Posts to the
// public POST /api/portal/login (same response whether or not the address
// is a client); the CAPTCHA step-up appears only when the server asks.

import { useState, type FormEvent } from "react";
import { Loader2, Mail } from "lucide-react";
import { Field, FieldMessage, aosButton } from "@/components/aos";
import { AuthShell, SentNotice } from "@/components/auth/AuthShell";
import { CaptchaWidget, type CaptchaPublicConfig } from "@/components/security/CaptchaWidget";

export default function PortalLoginClient({ captcha, enabled }: { captcha: CaptchaPublicConfig | null; enabled: boolean }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEmailError(null);
    if (!email.trim()) {
      setEmailError("Enter your email address.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, ...(captchaToken ? { captchaToken } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string; code?: string };
      if (res.ok) {
        setSent(data.message ?? "Check your email for a sign-in link.");
        return;
      }
      if (data.code === "captcha_required" && captcha) {
        setNeedCaptcha(true);
        setCaptchaKey((k) => k + 1);
      }
      const msg = res.status === 429 && !data.error ? "Too many requests. Wait a minute, then try again." : (data.error ?? "Something went wrong. Try again.");
      if (data.code === "invalid_email") setEmailError(msg);
      else setError(msg);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthShell>
        <SentNotice title="Check your email" message={sent}>
          <button type="button" onClick={() => setSent(null)} className={aosButton({ variant: "secondary", className: "mt-2 w-full" })}>
            Use a different email
          </button>
        </SentNotice>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="aos-heading">Client portal</h1>
      <p className="mt-2 text-sm text-muted">
        Sign in with the email your account team set up for you to see your invoices, quotes, projects, tickets and documents.
      </p>
      {enabled ? (
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
          <Field label="Email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={emailError} />
          {needCaptcha && captcha && <CaptchaWidget config={captcha} onToken={setCaptchaToken} resetKey={captchaKey} />}
          <FieldMessage id="portal-login-error" error={error} />
          <button type="submit" disabled={busy || (needCaptcha && !!captcha && !captchaToken)} className={aosButton({ className: "w-full" })}>
            {busy ? <Loader2 className="size-4 aos-spin" aria-hidden="true" /> : <Mail className="size-4" aria-hidden="true" />}
            {busy ? "Sending" : "Email me a sign-in link"}
          </button>
        </form>
      ) : (
        <p className="mt-6 text-sm text-muted">Email sign-in isn&apos;t configured on this server yet. Contact your account team.</p>
      )}
    </AuthShell>
  );
}
