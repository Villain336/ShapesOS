// Marketr — F6 launch-readiness actions (client).
// Mark checklist items complete (evidence required) or re-open them.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CompleteButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act() {
    const evidence = window.prompt(
      "Evidence URL or repo-relative doc path (e.g. docs/open-core-options.md).\nA checklist item is not done without proof:",
    );
    if (evidence === null) return;
    const note = window.prompt("Optional note:", "") ?? "";
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/flywheel/launch/checklist/${id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ evidence_url: evidence, note: note || undefined }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Completion failed");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={act}
        disabled={busy}
        className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-800 hover:border-stone-400 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Mark complete"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

export function ReopenButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function act() {
    const note = window.prompt("Why is this being re-opened?", "") ?? "";
    setBusy(true);
    try {
      await fetch(`/api/flywheel/launch/checklist/${id}/reopen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: note || undefined }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={act}
      disabled={busy}
      className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-500 hover:border-stone-400 hover:text-stone-800 disabled:opacity-50"
    >
      {busy ? "Saving…" : "Re-open"}
    </button>
  );
}
