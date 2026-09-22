// Marketr — sign-in page. Google OAuth when configured, SSO (generic OIDC /
// SAML via BoxyHQ) when configured, otherwise the self-hosted admin
// credential from ADMIN_EMAIL / ADMIN_PASSWORD.

"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-orange-500 focus:outline-none";

interface ProviderInfo {
  id: string;
  name: string;
}

// Day-1: honor a same-origin `next` redirect (e.g. /invite?token=…) so invite
import { safeNext } from "@/lib/auth/redirect";

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

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 font-sans text-zinc-900">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white/60 p-8">
        <h1 className="text-2xl font-bold tracking-tight">Marketr</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Sign in to your marketing workspace
        </p>

        <button
          onClick={() => signIn("google", { callbackUrl: next })}
          className="mt-6 w-full rounded-md border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm font-medium hover:bg-zinc-200"
        >
          Continue with Google
        </button>

        {sso.map((p) => (
          <button
            key={p.id}
            onClick={() => signIn(p.id, { callbackUrl: next })}
            className="mt-3 w-full rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
          >
            Continue with {p.name}
            {p.id === "boxyhq-saml" ? " (SAML SSO)" : ""}
          </button>
        ))}

        <div className="my-5 flex items-center gap-3 text-xs text-zinc-500">
          <span className="h-px flex-1 bg-zinc-200" />
          or self-host admin login
          <span className="h-px flex-1 bg-zinc-200" />
        </div>

        <form onSubmit={onCredentials} className="flex flex-col gap-3">
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
          />
          <input
            type="password"
            required
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-orange-700 px-3 py-2 text-sm font-medium text-white hover:bg-orange-800 disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
          >
            {busy ? "Signing in…" : "Sign in"}
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
    <Suspense fallback={<div className="p-8 text-center text-sm text-zinc-500">Loading…</div>}>
      <LoginBody />
    </Suspense>
  );
}
