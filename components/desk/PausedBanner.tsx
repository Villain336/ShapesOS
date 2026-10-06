"use client";

// ShapesOS — Phase 18.1 (WS=desk): "Agents paused" — shown on every page
// while the workspace is frozen by Control Center → Pause all agents (the
// kill switch). Ink, with the paused shape (two bars): paused is an agent
// state with no colour of its own (DESIGN.md). Admins get "Resume" here.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { aosButton } from "@/components/aos/button";
import { StatusShape } from "@/components/aos/StatusShape";
import { toast, toastError } from "@/lib/ui/feedback";
import { notifyControlChanged } from "./events";

export function PausedBanner({ since, canResume }: { since: string; canResume: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  let at = since;
  try {
    at = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(since));
  } catch {
    // keep the ISO string
  }
  async function resume() {
    setBusy(true);
    try {
      const res = await fetch("/api/desk/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resume" }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Agents were not resumed.");
      toast({ title: "Agents resumed" });
      notifyControlChanged();
      router.refresh();
    } catch (err) {
      toastError("Agents were not resumed", err instanceof Error ? err.message : undefined);
      setBusy(false);
    }
  }
  return (
    <div role="status" data-testid="paused-banner" className="aos-night flex min-h-[60px] flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 md:px-6">
      <StatusShape status="paused" size={14} tone="night" label="Paused" />
      <div className="min-w-0 flex-1">
        <p className="text-base leading-5 font-semibold text-paper">Agents paused</p>
        <p className="text-sm text-night-soft">
          Since {at}. Every run was stopped and nothing new starts{canResume ? " until you resume." : " until an admin resumes."}
        </p>
      </div>
      {canResume ? (
        <button type="button" onClick={() => void resume()} disabled={busy} className={aosButton({ variant: "night", size: "sm" })}>
          {busy ? "Resuming" : "Resume"}
        </button>
      ) : null}
    </div>
  );
}
