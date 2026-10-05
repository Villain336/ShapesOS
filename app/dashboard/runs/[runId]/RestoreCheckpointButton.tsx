"use client";

// ShapesOS — Phase 8: put the run's sandbox back to a checkpoint
// (POST /api/agent-runs/:id/restore — editors or the run's starter; only
// while the sandbox lives; the route re-checks everything).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { aosButton } from "@/components/aos";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";

export function RestoreCheckpointButton({ runId, snapshotId }: { runId: string; snapshotId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function restore() {
    const ok = await confirmAction({
      title: "Restore this checkpoint?",
      description: "The sandbox files go back to this point. Changes made since are lost.",
      confirmLabel: "Restore",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
      toast({ title: "Checkpoint restored", description: "The sandbox files are back to this point.", status: "done" });
      router.refresh();
    } catch (e) {
      toastError("Couldn't restore the checkpoint", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={() => void restore()} disabled={busy} className={aosButton({ variant: "secondary", size: "sm" })}>
      <RotateCcw className="size-4" aria-hidden />
      {busy ? "Restoring…" : "Restore"}
    </button>
  );
}

export default RestoreCheckpointButton;
