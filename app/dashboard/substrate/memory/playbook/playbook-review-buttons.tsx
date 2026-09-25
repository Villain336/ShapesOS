// Marketr — Phase 8 G3: playbook review buttons (client).

"use client";

import { useState } from "react";
import { Button } from "@/components/vault/shadcn/button";
import { Check, X } from "lucide-react";

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

  if (state === "done") return <p className="text-sm text-muted-foreground">Reviewed.</p>;

  return (
    <div className="flex gap-2">
      <Button size="sm" onClick={() => decide("approved")} disabled={state === "working"}>
        <Check className="mr-1 h-3.5 w-3.5" aria-hidden /> Approve
      </Button>
      <Button size="sm" variant="outline" onClick={() => decide("rejected")} disabled={state === "working"}>
        <X className="mr-1 h-3.5 w-3.5" aria-hidden /> Reject
      </Button>
      {state === "error" && <span className="text-xs text-destructive">Review failed — try again.</span>}
    </div>
  );
}
