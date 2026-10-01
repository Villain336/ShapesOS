// Marketr — Phase 8 G3: consolidation trigger button (client).

"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";

// Triggering a run -> running fill (run verb).
const btnRun =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-running px-4 text-sm font-semibold text-white aos-press hover:bg-running/90 disabled:opacity-40";

export default function ConsolidationTrigger({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<"idle" | "starting" | "started" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function trigger() {
    setState("starting");
    setMessage(null);
    try {
      const res = await fetch(
        `/api/substrate/memory/consolidation?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: "POST" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setState("started");
      setMessage(`Pass started (run ${String(data.runId).slice(0, 8)}…). Refresh for status.`);
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button className={btnRun} onClick={trigger} disabled={state === "starting"}>
        <RefreshCw className="h-4 w-4" aria-hidden />
        {state === "starting" ? "Starting…" : "Run consolidation pass"}
      </button>
      {message && <span className="text-xs text-muted">{message}</span>}
    </div>
  );
}
