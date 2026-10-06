// Marketr — sign-in page. Google OAuth when configured, SSO (generic OIDC /
// SAML via BoxyHQ) when configured, otherwise the self-hosted admin
// credential from ADMIN_EMAIL / ADMIN_PASSWORD.
//
// Phase 4a: passkey sign-in, the second step for accounts with two-factor
// auth (authenticator code, recovery code or passkey), and the CAPTCHA
// step-up after repeated failed passwords (only when a provider is set).
//
// Phase 6: an "Email" tab for email accounts (password or a magic link) next
// to the self-host "Admin" tab. Hidden entirely when email sign-in isn't
// configured (production without a mailer — lib/auth/email/mail.ts).

"use client";

import { signIn, signOut } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { KeyRound, Loader2, Mail, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmailSignIn } from "./EmailSignIn";
import { safeNext } from "@/lib/auth/redirect";
import { CaptchaWidget, type CaptchaPublicConfig } from "@/components/security/CaptchaWidget";
import {
  fetchAuthState,
  isPasskeyCancel,
  signInWithPasskey,
  usePasskeySupport,
  verifyCode,
} from "@/components/security/client";

const inputCls =
  "h-control w-full rounded-md border-[1.5px] bg-paper px-3 text-base text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-3 focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const primaryBtn =
  "aos-press inline-flex h-control w-full items-center justify-center gap-2 rounded-full bg-ink text-base font-semibold text-white hover:bg-ink-hover disabled:bg-disabled disabled:text-disabled-fg";
const secondaryBtn =
  "aos-press inline-flex h-control w-full items-center justify-center gap-2 rounded-full bg-paper text-base font-semibold text-ink shadow-outline disabled:bg-disabled disabled:text-disabled-fg";

interface ProviderInfo {
  id: string;
  name: string;
}

function ErrorLine({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} role="alert" className="flex items-center gap-2 text-sm text-failed-text">
      <span aria-hidden="true" className="inline-block size-2 shrink-0 bg-failed" />
      {message}
    </p>
  );
}

// Day-1: honor a same-origin `next` redirect (e.g. /invite?token=…) so invite
// links land back where they started.

function SecondStep({ methods, next }: { methods: string[]; next: string }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"code" | "passkey" | null>(null);
  const hasTotp = methods.includes("totp");
  const canPasskey = usePasskeySupport();
  const hasPasskey = methods.includes("passkey") && canPasskey;

  async function onCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy("code");
    try {
      const res = await verifyCode(code.trim());
      if (res.ok) {
        window.location.href = next;
        return;
      }
      setError(
        res.code === "locked"
          ? "Too many wrong codes. Wait a while, then try again."
          : "That code didn't work. Enter the newest code from your app, or a recovery code.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function onPasskey() {
    setError(null);
    setBusy("passkey");
    try {
      const res = await signInWithPasskey();
      if (res.ok) {
        window.location.href = next;
        return;
      }
      setError(res.code === "locked" ? "Too many attempts. Wait a while, then try again." : "That passkey didn't work. Try again.");
    } catch (err) {
      if (!isPasskeyCancel(err)) setError("Your passkey couldn't be checked. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const invalid = error !== null;
  return (
    <>
      <h1 className="aos-heading">Confirm it&apos;s you</h1>
      <p className="mt-1 text-sm text-muted">
        {hasTotp
          ? "Enter the 6-digit code from your authenticator app, or one of your recovery codes."
          : "Use your passkey to finish signing in."}
      </p>
      {hasTotp && (
        <form onSubmit={onCode} className="mt-6 flex flex-col gap-3">
          <label htmlFor="mfa-code" className="text-sm font-semibold text-ink">
            Code
          </label>
          <input
            id="mfa-code"
            autoFocus
            required
            inputMode="text"
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-invalid={invalid}
            aria-describedby={invalid ? "mfa-error" : undefined}
            className={`${inputCls} font-mono ${invalid ? "border-failed" : "border-control"}`}
          />
          {error && <ErrorLine id="mfa-error" message={error} />}
          <button type="submit" disabled={busy !== null || !code.trim()} className={primaryBtn}>
            {busy === "code" ? (
              <>
                <Loader2 className="size-4 aos-spin" aria-hidden="true" />
                Verifying
              </>
            ) : (
              "Verify"
            )}
          </button>
        </form>
      )}
      {hasPasskey && (
        <button type="button" onClick={onPasskey} disabled={busy !== null} className={`${secondaryBtn} mt-3`}>
          {busy === "passkey" ? <Loader2 className="size-4 aos-spin" aria-hidden="true" /> : <KeyRound className="size-4" aria-hidden="true" />}
          {busy === "passkey" ? "Waiting for your passkey" : "Use a passkey"}
        </button>
      )}
      {!hasTotp && error && <div className="mt-3"><ErrorLine id="mfa-error" message={error} /></div>}
      <button
        type="button"
        onClick={() => signOut({ callbackUrl: "/login" })}
        className="mt-5 w-full text-center text-sm text-muted hover:text-ink"
      >
        Use a different account
      </button>
    </>
  );
}

type LoginTab = "email" | "admin";

/** Pill segmented tabs (neutral: the selected tab is black, not a status colour). */
function LoginTabs({ tab, onChange }: { tab: LoginTab; onChange: (t: LoginTab) => void }) {
  const tabs: { id: LoginTab; label: string; Icon: typeof Mail }[] = [
    { id: "email", label: "Email", Icon: Mail },
    { id: "admin", label: "Admin", Icon: ShieldCheck },
  ];
  return (
    <div role="tablist" aria-label="Sign-in method" className="mb-5 flex items-center gap-0.5 rounded-full bg-canvas p-1">
      {tabs.map(({ id, label, Icon }) => {
        const on = id === tab;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`login-tab-${id}`}
            aria-selected={on}
            aria-controls={`login-panel-${id}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const nextTab = id === "email" ? "admin" : "email";
                onChange(nextTab);
                document.getElementById(`login-tab-${nextTab}`)?.focus();
              }
            }}
            className={cn(
              "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full text-sm font-semibold transition-[background-color,color] duration-150",
              on ? "bg-ink text-paper" : "text-ink hover:bg-hover",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function LoginBody({ captcha, emailAuth }: { captcha: CaptchaPublicConfig | null; emailAuth: boolean }) {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  // SSO providers are discovered client-side so the buttons only render when
  // the operator actually configured OIDC / SAML (milestone 11).
  const [sso, setSso] = useState<ProviderInfo[]>([]);
  // Phase 4a: second-factor step + CAPTCHA step-up.
  const [pending, setPending] = useState<{ methods: string[] } | null>(null);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const canPasskey = usePasskeySupport();
  const [tab, setTab] = useState<LoginTab>(emailAuth ? "email" : "admin");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/providers")
      .then((r) => (r.ok ? r.json() : null))
      .then((all: Record<string, ProviderInfo> | null) => {
        if (cancelled || !all) return;
        setSso(
          Object.values(all).filter(
            (p) => p.id === "oidc" || p.id === "boxyhq-saml",
          ),
        );
      })
      .catch(() => {});
    // Returning from an OAuth/SSO redirect (or bounced by the proxy) with a
    // sign-in that still needs its second factor.
    fetchAuthState()
      .then((s) => {
        if (!cancelled && s.pending) setPending({ methods: s.methods });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function onCredentials(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await signIn("credentials", {
        email,
        password,
        ...(captchaToken ? { captchaToken } : {}),
        redirect: false,
        callbackUrl: next,
      });
      if (res?.error) {
        if (res.code === "captcha_required" && captcha) {
          setNeedCaptcha(true);
          setError("Complete the security check, then sign in again.");
        } else {
          setError("Invalid email or password.");
        }
        // CAPTCHA tokens are single use: get a fresh challenge.
        if (needCaptcha || res.code === "captcha_required") setCaptchaKey((k) => k + 1);
        return;
      }
      const state = await fetchAuthState();
      if (state.pending) {
        setPending({ methods: state.methods });
        return;
      }
      window.location.href = res?.url ?? "/dashboard";
    } finally {
      setBusy(false);
    }
  }

  async function onPasskey() {
    setError(null);
    setPasskeyBusy(true);
    try {
      const res = await signInWithPasskey();
      if (res.ok) {
        window.location.href = next;
        return;
      }
      setError(res.code === "locked" ? "Too many attempts. Wait a while, then try again." : "That passkey isn't registered here.");
    } catch (err) {
      if (!isPasskeyCancel(err)) setError("Your passkey couldn't be checked. Try again.");
    } finally {
      setPasskeyBusy(false);
    }
  }

  const invalid = error !== null;
  const fieldCls = `${inputCls} ${invalid ? "border-failed" : "border-control"}`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-sm rounded-lg bg-paper p-8 shadow-hairline">
        {pending ? (
          <SecondStep methods={pending.methods} next={next} />
        ) : (
          <>
            <h1 className="aos-heading">ShapesOS</h1>
            <p className="mt-1 text-sm text-muted">
              Sign in to your marketing workspace
            </p>

            <button
              onClick={() => signIn("google", { callbackUrl: next })}
              className={`${secondaryBtn} mt-6`}
            >
              Continue with Google
            </button>

            {sso.map((p) => (
              <button
                key={p.id}
                onClick={() => signIn(p.id, { callbackUrl: next })}
                className={`${secondaryBtn} mt-3`}
              >
                Continue with {p.name}
                {p.id === "boxyhq-saml" ? " (SAML SSO)" : ""}
              </button>
            ))}

            {canPasskey && (
              <button type="button" onClick={onPasskey} disabled={passkeyBusy} className={`${secondaryBtn} mt-3`}>
                {passkeyBusy ? <Loader2 className="size-4 aos-spin" aria-hidden="true" /> : <KeyRound className="size-4" aria-hidden="true" />}
                {passkeyBusy ? "Waiting for your passkey" : "Sign in with a passkey"}
              </button>
            )}

            <div className="my-5 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-line" />
              {emailAuth ? "or" : "or self-host admin login"}
              <span className="h-px flex-1 bg-line" />
            </div>

            {emailAuth && <LoginTabs tab={tab} onChange={setTab} />}

            {emailAuth && tab === "email" && (
              <div role="tabpanel" id="login-panel-email" aria-labelledby="login-tab-email">
                <EmailSignIn captcha={captcha} next={next} onPending={(methods) => setPending({ methods })} />
              </div>
            )}

            {(!emailAuth || tab === "admin") && (
            <form
              onSubmit={onCredentials}
              className="flex flex-col gap-3"
              {...(emailAuth ? { role: "tabpanel", id: "login-panel-admin", "aria-labelledby": "login-tab-admin" } : {})}
            >
              <input
                type="email"
                required
                placeholder="Email"
                autoComplete="username webauthn"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={invalid}
                aria-describedby={invalid ? "login-error" : undefined}
                className={fieldCls}
              />
              <input
                type="password"
                required
                placeholder="Password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={invalid}
                aria-describedby={invalid ? "login-error" : undefined}
                className={fieldCls}
              />
              {needCaptcha && captcha && (
                <CaptchaWidget config={captcha} onToken={setCaptchaToken} resetKey={captchaKey} />
              )}
              {error && <ErrorLine id="login-error" message={error} />}
              <button
                type="submit"
                disabled={busy || (needCaptcha && !captchaToken)}
                className={primaryBtn}
              >
                {busy ? (
                  <>
                    <Loader2 className="size-4 aos-spin" aria-hidden="true" />
                    Signing in
                  </>
                ) : (
                  "Sign in"
                )}
              </button>
            </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Wraps the body in Suspense: useSearchParams() requires a suspense boundary
// for static prerendering (per the local Next.js docs).
export default function LoginClient({
  captcha,
  emailAuth = false,
}: {
  captcha: CaptchaPublicConfig | null;
  /** Email accounts are usable on this deployment (a mailer, or development). */
  emailAuth?: boolean;
}) {
  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-muted">Loading…</div>}>
      <LoginBody captcha={captcha} emailAuth={emailAuth} />
    </Suspense>
  );
}
