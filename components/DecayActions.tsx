// Marketr — decay finding actions (milestone 14, client island).
"use client";

import { useState } from "react";

export default function DecayActions({ projectId, findingId }: { projectId: string; findingId: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "dismiss" | "create_brief") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/decay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, findingId, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Action failed");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return <p className="text-sm text-emerald-400">✓ Handled — finding closed.</p>;
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <button
          onClick={() => act("create_brief")}
          disabled={busy !== null}
          className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50"
        >
          {busy === "create_brief" ? "Creating…" : "Create refresh brief →"}
        </button>
        <button
          onClick={() => act("dismiss")}
          disabled={busy !== null}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
        >
          {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
