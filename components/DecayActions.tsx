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
    return <p className="text-sm font-semibold text-ink">✓ Handled — finding closed.</p>;
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <button
          onClick={() => act("create_brief")}
          disabled={busy !== null}
          className="inline-flex h-control-sm items-center whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press hover:bg-night-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === "create_brief" ? "Creating…" : "Create refresh brief →"}
        </button>
        <button
          onClick={() => act("dismiss")}
          disabled={busy !== null}
          className="inline-flex h-control-sm items-center whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
        </button>
      </div>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-failed-text">
          <span className="aos-shape aos-shape--failed mt-0.5 shrink-0 [--aos-shape-size:8px]" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}
