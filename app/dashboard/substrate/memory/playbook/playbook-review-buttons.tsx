// Marketr — Phase 8 G3: playbook review buttons (client).

"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";

// Approve -> done fill, reject -> deny idiom (human approval workflow).
const btnApprove =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press hover:bg-done/90 disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";

export default function PlaybookReviewButtons({
  workspaceId,
  playbookId,
}: {
  workspaceId: string;
  playbookId: string;
}) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");

  async function decide(decision: "approved" | "rejected") {
    setState("working");
    try {
      const res = await fetch(
        `/api/substrate/memory/playbook/${playbookId}/review?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setState("done");
    } catch {
      setState("error");
    }
  }

  if (state === "done") return <p className="text-sm text-muted">Reviewed.</p>;

  return (
    <div className="flex gap-2">
      <button className={btnApprove} onClick={() => decide("approved")} disabled={state === "working"}>
        <Check className="h-3.5 w-3.5" aria-hidden /> Approve
      </button>
      <button className={btnDeny} onClick={() => decide("rejected")} disabled={state === "working"}>
        <X className="h-3.5 w-3.5" aria-hidden /> Reject
      </button>
      {state === "error" && <span className="text-xs text-failed-text">Review failed — try again.</span>}
    </div>
  );
}
