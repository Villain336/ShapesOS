// Marketr — sign-in page. Google OAuth when configured, SSO (generic OIDC /
// SAML via BoxyHQ) when configured, otherwise the self-hosted admin
// credential from ADMIN_EMAIL / ADMIN_PASSWORD.

"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";

const inputCls =
  "w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none";

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
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 font-sans text-zinc-50">
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/60 p-8">
        <h1 className="text-2xl font-bold tracking-tight">Marketr</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Sign in to your marketing workspace
        </p>

        <button
          onClick={() => signIn("google", { callbackUrl: next })}
          className="mt-6 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-medium hover:bg-zinc-700"
        >
          Continue with Google
        </button>

        {sso.map((p) => (
          <button
            key={p.id}
            onClick={() => signIn(p.id, { callbackUrl: next })}
            className="mt-3 w-full rounded-md border border-indigo-700 bg-indigo-950 px-3 py-2 text-sm font-medium text-indigo-100 hover:bg-indigo-900"
          >
            Continue with {p.name}
            {p.id === "boxyhq-saml" ? " (SAML SSO)" : ""}
          </button>
        ))}

        <div className="my-5 flex items-center gap-3 text-xs text-zinc-600">
          <span className="h-px flex-1 bg-zinc-800" />
          or self-host admin login
          <span className="h-px flex-1 bg-zinc-800" />
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
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50"
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
    <Suspense fallback={<div className="p-8 text-center text-sm text-zinc-400">Loading…</div>}>
      <LoginBody />
    </Suspense>
  );
}
