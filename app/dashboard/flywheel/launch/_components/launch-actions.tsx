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
        className="inline-flex h-control-sm cursor-pointer items-center justify-center whitespace-nowrap rounded-full bg-done px-4 text-xs font-semibold text-white aos-press hover:brightness-110 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Mark complete"}
      </button>
      {error && <span className="text-xs text-failed-text">{error}</span>}
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
      className="inline-flex h-control-sm cursor-pointer items-center justify-center whitespace-nowrap rounded-full bg-paper px-4 text-xs font-semibold text-muted shadow-outline aos-press hover:bg-hover-paper hover:text-ink disabled:opacity-50"
    >
      {busy ? "Saving…" : "Re-open"}
    </button>
  );
}
