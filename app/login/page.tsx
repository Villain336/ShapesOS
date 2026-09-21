"use client";

// Marketr — sign-in page. Google OAuth when configured, otherwise the
// self-hosted admin credential from ADMIN_EMAIL / ADMIN_PASSWORD.

import { signIn } from "next-auth/react";
import { useState, type FormEvent } from "react";

const inputCls =
  "w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onCredentials(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false,
        callbackUrl: "/dashboard",
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
          onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
          className="mt-6 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-medium hover:bg-zinc-700"
        >
          Continue with Google
        </button>

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
