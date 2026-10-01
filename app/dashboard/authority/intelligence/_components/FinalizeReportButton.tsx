// Marketr — I1 finalize action (client): draft → ready.
// Human review flips the report to the operating baseline; optional full
// initiative order is applied first when the plan was reprioritized.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Loader2 } from "lucide-react";

export function FinalizeReportButton({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finalize() {
    if (!window.confirm("Mark this report ready? It becomes the client's 90-day operating baseline.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/authority/intelligence/reports/${reportId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "ready" }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Finalize failed");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={finalize}
        disabled={busy}
        className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />}
        {busy ? "Finalizing…" : "Mark ready"}
      </button>
      {error && <span className="text-xs text-failed-text">{error}</span>}
    </span>
  );
}
