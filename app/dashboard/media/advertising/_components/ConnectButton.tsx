// Marketr — Phase 18 slice 1: per-platform connect button.
//
// OAuth platforms navigate to the consent URL from /api/ads/oauth/start.
// Key-based and guided platforms show their honest state instead of a dead
// button.

"use client";

import { useState } from "react";
import { Clock, KeyRound, Loader2, PlugZap } from "lucide-react";

const btnPrimarySm =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnSecondarySm =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const inputCls =
  "h-control rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

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
      <span className="inline-flex items-center gap-1.5 text-sm text-muted">
        <PlugZap className="h-3.5 w-3.5 text-ink" />
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
        className={btnPrimarySm}
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
        className={`${inputCls} w-64`}
      />
      <span className="inline-flex gap-1.5">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className={btnSecondarySm}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={connect}
          disabled={busy || !key.trim()}
          className={btnPrimarySm}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
          {busy ? "Validating…" : "Validate & connect"}
        </button>
      </span>
      {error && <span className="max-w-64 text-right text-xs text-failed-text">{error}</span>}
      <span className="max-w-64 text-right text-xs text-subtle">
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
  if (platformKey === "zernio") {
    // Phase 15.4 (zernio): ad accounts connect on the Zernio card (one
    // profile per workspace; the platform key is pre-added).
    return (
      <a href="/dashboard/settings/connectors#zernio" className={btnPrimarySm}>
        <PlugZap className="h-3.5 w-3.5" />
        Connect ad accounts
      </a>
    );
  }
  if (platformKey === "spotify" || platformKey === "walmart") {
    // Tico 2026-09-30: both ship as "coming soon" in the hub — the guided
    // flows stay in the codebase, staged behind this badge until launch.
    const label = platformKey === "spotify" ? "Spotify" : "Walmart Connect";
    return (
      <span
        className="inline-flex h-chip items-center gap-1.5 rounded-full border border-line bg-paper px-3 text-sm font-semibold text-muted"
        title={`${label} is coming soon`}
      >
        <Clock className="h-3.5 w-3.5" />
        Coming soon
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
        className={btnPrimarySm}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
        {busy ? "Opening…" : `Connect ${displayName}`}
      </button>
      {error && <span className="text-xs text-failed-text">{error}</span>}
    </span>
  );
}
