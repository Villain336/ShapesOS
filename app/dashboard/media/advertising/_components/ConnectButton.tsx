// Marketr — Phase 18 slice 1: per-platform connect button.
//
// OAuth platforms navigate to the consent URL from /api/ads/oauth/start.
// Key-based and guided platforms show their honest state instead of a dead
// button.

"use client";

import { useState } from "react";
import { KeyRound, ListChecks, Loader2, PlugZap } from "lucide-react";

function StackAdaptKeyForm() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ads/apikey/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platformKey: "stackadapt", apiKey: key }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; code?: string; advertiserName?: string };
      if (!res.ok || !data.ok) {
        setError(
          data.code === "AUTH_FAILED"
            ? "That key was rejected by StackAdapt — check the GraphQL API key (not the REST key) and try again."
            : (data.error ?? "Could not connect the key"),
        );
        return;
      }
      setDone(true);
      setKey("");
    } catch {
      setError("Could not connect the key");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-emerald-700">
        <PlugZap className="h-3.5 w-3.5" />
        Connected — refresh to see the account
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Paste your StackAdapt GraphQL API key (Account Settings → API Integration). The key is validated before it is stored in the vault."
        className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)]"
      >
        <KeyRound className="h-3.5 w-3.5" />
        Connect API key
      </button>
    );
  }

  return (
    <span className="inline-flex flex-col items-end gap-1.5">
      <input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="StackAdapt GraphQL API key"
        autoComplete="off"
        className="w-64 rounded-md border border-stone-300 px-2.5 py-1.5 text-[12px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none"
      />
      <span className="inline-flex gap-1.5">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded-md border border-stone-300 px-3 py-1.5 text-[12px] font-medium text-stone-700 hover:bg-stone-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={connect}
          disabled={busy || !key.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
          {busy ? "Validating…" : "Validate & connect"}
        </button>
      </span>
      {error && <span className="max-w-64 text-right text-[11px] text-red-600">{error}</span>}
      <span className="max-w-64 text-right text-[11px] text-stone-400">
        Validated against StackAdapt before storing. Uses the GraphQL key, not the REST key.
      </span>
    </span>
  );
}

export default function ConnectButton({
  platformKey,
  displayName,
}: {
  platformKey: string;
  displayName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (platformKey === "stackadapt") {
    return <StackAdaptKeyForm />;
  }
  if (platformKey === "spotify") {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-stone-500" title="Spotify has no campaign API — the guided setup flow lands in slice 5">
        <ListChecks className="h-3.5 w-3.5" />
        Guided in slice 5
      </span>
    );
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ads/oauth/start?platform=${encodeURIComponent(platformKey)}`);
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "Could not start OAuth");
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Could not start OAuth");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={connect}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
        {busy ? "Opening…" : `Connect ${displayName}`}
      </button>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </span>
  );
}
