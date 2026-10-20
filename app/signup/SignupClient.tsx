"use client";

// ShapesOS — signup form (Phase 6). POST /api/auth/email/signup creates an
// unverified account and emails a verification link; the answer is the same
// whether or not the address already has an account.

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Field, FieldMessage, aosButton } from "@/components/aos";
import { AuthShell, SentNotice } from "@/components/auth/AuthShell";
import { useI18n } from "@/components/i18n/I18nProvider";
import { postEmailAuth } from "@/components/auth/client";
import { CaptchaWidget, type CaptchaPublicConfig } from "@/components/security/CaptchaWidget";

type FieldErrors = { name?: string; email?: string; password?: string; form?: string };

export default function SignupClient({
  captcha,
  enabled,
  inviteOnly,
}: {
  captcha: CaptchaPublicConfig | null;
  enabled: boolean;
  inviteOnly: boolean;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [inviteRequired, setInviteRequired] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  // Beta readiness (WS=legal): the consent line above the submit button.
  const { t } = useI18n();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setBusy(true);
    try {
      const res = await postEmailAuth("signup", { name, email, password, ...(captchaToken ? { captchaToken } : {}) });
      if (res.ok) {
        setSent(res.message);
        return;
      }
      if (captcha) setCaptchaKey((k) => k + 1);
      if (res.status === 403) {
        setInviteRequired(true);
        return;
      }
      if (res.code === "invalid_name") setErrors({ name: res.message });
      else if (res.code === "invalid_email") setErrors({ email: res.message });
      else if (res.code === "weak_password") setErrors({ password: res.message });
      else setErrors({ form: res.message });
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) {
    return (
      <AuthShell>
        <h1 className="aos-heading">Sign-up isn&apos;t available</h1>
        <p className="mt-2 text-sm text-muted">
          Email sign-up isn&apos;t configured on this server. Sign in another way, or ask the operator to set up email.
        </p>
        <Link href="/login" className={aosButton({ variant: "secondary", className: "mt-6 w-full" })}>
          Go to sign in
        </Link>
      </AuthShell>
    );
  }

  if (sent) {
    return (
      <AuthShell>
        <SentNotice title="Check your email" message={sent}>
          <p className="text-sm text-muted">The link expires in 24 hours. You can sign in with your password once your email is confirmed.</p>
          <Link href="/login" className={aosButton({ variant: "secondary", className: "mt-2 w-full" })}>
            Go to sign in
          </Link>
        </SentNotice>
      </AuthShell>
    );
  }

  if (inviteRequired) {
    return (
      <AuthShell>
        <h1 className="aos-heading">Invite required</h1>
        <p className="mt-2 text-sm text-muted">
          This ShapesOS instance is invite-only. Ask a workspace admin to invite this email address, then sign up with the same address.
        </p>
        <button type="button" onClick={() => setInviteRequired(false)} className={aosButton({ variant: "secondary", className: "mt-6 w-full" })}>
          Try a different email
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="aos-heading">Create your account</h1>
      <p className="mt-1 text-sm text-muted">
        {inviteOnly ? "Use the email address your invite was sent to." : "Sign up with your email address."}
      </p>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
        <Field label="Name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          helper="At least 10 characters. Avoid common passwords."
          error={errors.password}
        />
        {captcha && <CaptchaWidget config={captcha} onToken={setCaptchaToken} resetKey={captchaKey} />}
        <FieldMessage id="signup-error" error={errors.form} />
        <p className="text-sm text-muted" data-testid="signup-consent">
          {t("legal.consent.prefix")}{" "}
          <Link href="/terms" className="font-semibold text-ink underline-offset-2 hover:underline">
            {t("legal.consent.terms")}
          </Link>{" "}
          {t("legal.consent.and")}{" "}
          <Link href="/privacy" className="font-semibold text-ink underline-offset-2 hover:underline">
            {t("legal.consent.privacy")}
          </Link>
          .
        </p>
        <button
          type="submit"
          disabled={busy || !name.trim() || !email.trim() || !password || (!!captcha && !captchaToken)}
          className={aosButton({ className: "w-full" })}
        >
          {busy ? (
            <>
              <Loader2 className="size-4 aos-spin" aria-hidden="true" />
              Creating account
            </>
          ) : (
            "Create account"
          )}
        </button>
      </form>
      <p className="mt-5 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-ink underline-offset-2 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
