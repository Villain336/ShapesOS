// Marketr — Phase 17 slice 7: OpsWorkflowRunCard, a registered generative
// component. The agent emits only { runId }; the card loads the live
// workflow-run record from the ops API. Presentational only — launching and
// retrying runs happen through the Actions queue / ops routes after human
// approval; the card never reimplements run logic.
//
// House pattern: Agentic OS (docs/design/DESIGN.md) — tokens only, run states as
// color + shape; Lucide icons only.

"use client";

import { useCallback, useEffect, useState } from "react";
import { GitBranch, Loader2, Undo2 } from "lucide-react";

export interface OpsWorkflowRunCardProps {
  /** Workflow run id (or runKey — the card matches either). */
  runId: string;
}

interface StepState {
  name: string;
  status: string;
  errorMessage?: string | null;
}

interface CompLogEntry {
  at: string;
  step: string;
  action: string;
  ok: boolean;
  detail?: string | null;
}

interface RunRow {
  id: string;
  workflowName: string;
  runKey: string;
  status: string;
  stepStates: StepState[];
  compensationLog: CompLogEntry[];
  failure: { step: string; errorMessage: string; at: string } | null;
}

// A workflow run is an agent run: status badges carry the DESIGN.md color +
// shape (running blue circle, done green quarter-disc, failed red square).
// "compensated" (rolled back) is not one of the four states, so it stays ink.
const STATUS_BADGE: Record<string, string> = {
  running: "bg-running text-paper",
  done: "bg-done text-paper",
  failed: "bg-failed text-paper",
  compensated: "bg-paper text-ink shadow-outline",
};

const STATUS_SHAPE: Record<string, string> = {
  running: "aos-shape aos-shape--running aos-is-live",
  done: "aos-shape aos-shape--done",
  failed: "aos-shape aos-shape--failed",
};

const STEP_SHAPE: Record<string, string> = {
  pending: "aos-shape aos-shape--queued",
  running: "aos-shape aos-shape--running aos-is-live",
  done: "aos-shape aos-shape--done",
  failed: "aos-shape aos-shape--failed",
  compensated: "h-2 w-2 rounded-full bg-muted",
  skipped: "h-2 w-2 rounded-full bg-line-strong",
};

export function OpsWorkflowRunCard({ runId }: OpsWorkflowRunCardProps) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/ops/workflow-runs?limit=200`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: RunRow[] };
      const found = (data.items ?? []).find((r) => r.id === runId || r.runKey === runId) ?? null;
      setRun(found);
      if (!found) setError("Workflow run not found in this workspace.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load workflow run.");
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !run) {
    return (
      <div className="rounded-lg bg-paper p-4 text-[0.8125rem] text-muted shadow-hairline">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="rounded-lg bg-paper p-4 text-[0.8125rem] text-muted shadow-hairline">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading workflow run…</span>
        </div>
      </div>
    );
  }

  const doneSteps = run.stepStates.filter((s) => s.status === "done").length;

  return (
    <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
      <div className="flex items-center justify-between border-b border-line bg-canvas px-4 py-2.5">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-ink" />
          <span className="text-sm font-semibold text-ink">
            {run.workflowName}
          </span>
          <span className="text-[0.75rem] text-muted">
            run {run.runKey} · {doneSteps}/{run.stepStates.length} steps done
          </span>
        </div>
        <span
          className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[0.75rem] font-semibold ${
            STATUS_BADGE[run.status] ?? STATUS_BADGE.running
          }`}
        >
          {STATUS_SHAPE[run.status] && (
            // Inside a filled badge the shape takes the badge's text color.
            <span className={`${STATUS_SHAPE[run.status]} [--aos-shape-size:9px]`} style={{ color: "inherit" }} aria-hidden="true" />
          )}
          {run.status}
        </span>
      </div>
      <ul className="divide-y divide-line">
        {run.stepStates.map((s) => (
          <li key={s.name} className="flex items-center gap-3 px-4 py-2 text-[0.8125rem]">
            <span className={`shrink-0 [--aos-shape-size:9px] ${STEP_SHAPE[s.status] ?? STEP_SHAPE.pending}`} aria-hidden="true" />
            <span className="font-medium text-ink">{s.name}</span>
            <span className="text-[0.75rem] text-muted">{s.status}</span>
            {s.errorMessage && <span className="truncate text-[0.75rem] text-failed-text">{s.errorMessage}</span>}
          </li>
        ))}
      </ul>
      {run.failure && (
        <div role="alert" className="border-t border-line bg-failed-tint px-4 py-2 text-[0.75rem] text-failed-text">
          Failed at step {run.failure.step}: {run.failure.errorMessage}
        </div>
      )}
      {run.compensationLog.length > 0 && (
        <div className="border-t border-line px-4 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[0.75rem] font-medium text-ink">
            <Undo2 className="h-3.5 w-3.5" />
            Rollback log
          </div>
          <ul className="space-y-0.5 text-[0.75rem] text-muted">
            {run.compensationLog.map((c, i) => (
              <li key={i}>
                <span className={c.ok ? "text-ink" : "text-failed-text"}>
                  {c.ok ? "✓" : "✗"} {c.step} → {c.action}
                </span>
                {c.detail && <span className="text-muted"> — {c.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
