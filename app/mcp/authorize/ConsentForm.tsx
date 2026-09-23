"use client";

// Marketr — OAuth consent form (Phase C, W5). Client component: POSTs the
// sealed grant + decision as JSON, then follows the server-issued redirect.

import { useState } from "react";

export function ConsentForm({ grant }: { grant: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/oauth/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant, decision }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Authorization failed");
        setBusy(false);
        return;
      }
      if (data.redirect) window.location.href = data.redirect;
      else setError("No redirect returned");
    } catch {
      setError("Network error");
    }
    setBusy(false);
  }

  return (
    <div className="mt-6 flex gap-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => decide("approve")}
        className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Working…" : "Approve"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => decide("deny")}
        className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 disabled:opacity-50"
      >
        Deny
      </button>
      {error && <p className="self-center text-sm text-red-600">{error}</p>}
    </div>
  );
}
