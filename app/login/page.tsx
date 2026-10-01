// Marketr — sign-in page. Google OAuth when configured, SSO (generic OIDC /
// SAML via BoxyHQ) when configured, otherwise the self-hosted admin
// credential from ADMIN_EMAIL / ADMIN_PASSWORD.

"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { safeNext } from "@/lib/auth/redirect";

const inputCls =
  "h-control w-full rounded-md border-[1.5px] bg-paper px-3 text-base text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-3 focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

interface ProviderInfo {
  id: string;
  name: string;
}

// Day-1: honor a same-origin `next` redirect (e.g. /invite?token=…) so invite
// links land back where they started.

function LoginBody() {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // SSO providers are discovered client-side so the buttons only render when
  // the operator actually configured OIDC / SAML (milestone 11).
  const [sso, setSso] = useState<ProviderInfo[]>([]);

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
        redirect: false,
        callbackUrl: next,
      });
      if (res?.error) {
        setError("Invalid email or password.");
      } else {
        window.location.href = res?.url ?? "/dashboard";
      }
    } finally {
      setBusy(false);
    }
  }

  const invalid = error !== null;
  const fieldCls = `${inputCls} ${invalid ? "border-failed" : "border-control"}`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-sm rounded-lg bg-paper p-8 shadow-hairline">
        <h1 className="aos-heading">Marketr</h1>
        <p className="mt-1 text-sm text-muted">
          Sign in to your marketing workspace
        </p>

        <button
          onClick={() => signIn("google", { callbackUrl: next })}
          className="aos-press mt-6 inline-flex h-control w-full items-center justify-center gap-2 rounded-full bg-paper text-base font-semibold text-ink shadow-outline"
        >
          Continue with Google
        </button>

        {sso.map((p) => (
          <button
            key={p.id}
            onClick={() => signIn(p.id, { callbackUrl: next })}
            className="aos-press mt-3 inline-flex h-control w-full items-center justify-center gap-2 rounded-full bg-paper text-base font-semibold text-ink shadow-outline"
          >
            Continue with {p.name}
            {p.id === "boxyhq-saml" ? " (SAML SSO)" : ""}
          </button>
        ))}

        <div className="my-5 flex items-center gap-3 text-xs text-muted">
          <span className="h-px flex-1 bg-line" />
          or self-host admin login
          <span className="h-px flex-1 bg-line" />
        </div>

        <form onSubmit={onCredentials} className="flex flex-col gap-3">
          <input
            type="email"
            required
            placeholder="Email"
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
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={invalid}
            aria-describedby={invalid ? "login-error" : undefined}
            className={fieldCls}
          />
          {error && (
            <p
              id="login-error"
              role="alert"
              className="flex items-center gap-2 text-sm text-failed-text"
            >
              <span
                aria-hidden="true"
                className="inline-block size-2 shrink-0 bg-failed"
              />
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="aos-press inline-flex h-control w-full items-center justify-center gap-2 rounded-full bg-ink text-base font-semibold text-white hover:bg-night-hover disabled:bg-disabled disabled:text-disabled-fg"
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
      </div>
    </div>
  );
}

// Default export wraps the body in Suspense: useSearchParams() requires a
// suspense boundary for static prerendering (per the local Next.js docs).
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-muted">Loading…</div>}>
      <LoginBody />
    </Suspense>
  );
}
