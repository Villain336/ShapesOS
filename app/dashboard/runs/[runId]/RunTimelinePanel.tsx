"use client";

// ShapesOS — the run viewer's timeline card (kit: agent-blocks.png "Weekly
// competitor brief"). Steps come from the server (lib/aos/runs runTimeline);
// this wrapper adds the controls the run supports: a mission run can be
// paused and resumed through its mission's kill switch (POST
// /api/missions/:id/pause | resume, editor+ — the route re-checks the role
// and re-verifies staleness on resume). Phase 5: a live run can be stopped
// (POST /api/agent-runs/:id/cancel — the run and every sub-agent run under
// it stop before their next step; pending approvals they raised expire).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RunTimeline, aosButton, type TimelineStep } from "@/components/aos";
import type { AosStatus } from "@/lib/aos/status";
import { toast, toastError } from "@/lib/ui/feedback";

export function RunTimelinePanel({
  title,
  subtitle,
  status,
  neutral,
  steps,
  completed,
  control,
  stopRunId,
  olderCursor = null,
  runId,
}: {
  title: string;
  subtitle: string;
  status: AosStatus;
  /** No agent state (cancelled): a neutral chip instead of a status badge. */
  neutral: boolean;
  steps: TimelineStep[];
  completed: number;
  /** Present when the viewer may pause/resume this run's mission. */
  control: { missionId: string; can: "pause" | "resume" } | null;
  /** Phase 5: present when the viewer may stop this live run. */
  stopRunId?: string | null;
  /** Phase 17: the page shows the newest steps; this cursor loads earlier ones (null = none). */
  olderCursor?: number | null;
  runId?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // Phase 17: earlier steps loaded on demand (oldest first), all done by
  // definition — they precede the page's steps, so `completed` grows by them.
  const [older, setOlder] = useState<TimelineStep[]>([]);
  const [cursor, setCursor] = useState<number | null>(olderCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);

  async function loadOlder() {
    if (cursor === null || !runId) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/events?before=${cursor}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { steps?: TimelineStep[]; before?: number | null; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
      setOlder((prev) => [...(body.steps ?? []), ...prev]);
      setCursor(body.before ?? null);
    } catch (e) {
      toastError("Couldn't load earlier steps", e instanceof Error ? e.message : undefined);
    } finally {
      setLoadingOlder(false);
    }
  }

  async function act(action: "pause" | "resume") {
    if (!control) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(control.missionId)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; staleness?: { fresh: boolean } };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
      if (action === "resume" && body.staleness && !body.staleness.fresh) {
        toastError("Still paused", "The mission's data is stale, so it stays paused for a human review.");
      } else {
        toast({ title: action === "pause" ? "Paused" : "Resumed", description: action === "pause" ? "The mission stops after the current step." : "The mission picks up where it stopped.", status: action === "pause" ? "done" : "running" });
      }
      router.refresh();
    } catch (e) {
      toastError(action === "pause" ? "Couldn't pause" : "Couldn't resume", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function stopRun() {
    if (!stopRunId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/agent-runs/${encodeURIComponent(stopRunId)}/cancel`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; stopped?: string[] };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
      toast({
        title: body.stopped?.length ? "Stopping" : "Already finished",
        description: body.stopped?.length ? "The agent stops before its next step." : "This run had already finished.",
        status: "done",
      });
      router.refresh();
    } catch (e) {
      toastError("Couldn't stop the run", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <RunTimeline
      headingLevel="h1"
      title={title}
      subtitle={subtitle}
      status={status}
      badge={
        neutral ? (
          <span className="inline-flex h-badge items-center rounded-full bg-paper px-3 text-sm font-semibold text-muted shadow-control">
            Cancelled
          </span>
        ) : undefined
      }
      steps={older.length ? [...older, ...steps] : steps}
      completed={completed + older.length}
      busy={busy}
      footer={
        cursor !== null ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted">Showing the latest steps. Earlier ones load above.</span>
            <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder} className={aosButton({ variant: "secondary", size: "sm" })}>
              {loadingOlder ? "Loading earlier steps" : "Load earlier steps"}
            </button>
          </div>
        ) : undefined
      }
      pauseLabel="Pause this mission"
      resumeLabel="Resume this mission"
      onPause={control?.can === "pause" ? () => void act("pause") : undefined}
      onResume={control?.can === "resume" ? () => void act("resume") : undefined}
      onStop={stopRunId ? () => void stopRun() : undefined}
      emptyText="No steps recorded yet."
    />
  );
}

export default RunTimelinePanel;
