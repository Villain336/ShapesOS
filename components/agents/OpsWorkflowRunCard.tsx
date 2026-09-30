// Marketr — Phase 17 slice 7: OpsWorkflowRunCard, a registered generative
// component. The agent emits only { runId }; the card loads the live
// workflow-run record from the ops API. Presentational only — launching and
// retrying runs happen through the Actions queue / ops routes after human
// approval; the card never reimplements run logic.
//
// House pattern: --brand-600/700/50 vars, never hardcoded primaries; Lucide
// icons only.

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

const STATUS_BADGE: Record<string, string> = {
  running: "bg-sky-50 text-sky-800 border-sky-200",
  done: "bg-[var(--brand-50)] text-[var(--brand-700)] border-[var(--brand-600)]/20",
  failed: "bg-rose-50 text-rose-800 border-rose-200",
  compensated: "bg-amber-50 text-amber-800 border-amber-200",
};

const STEP_DOT: Record<string, string> = {
  pending: "bg-stone-200",
  running: "bg-sky-400 animate-pulse",
  done: "bg-[var(--brand-600)]",
  failed: "bg-rose-500",
  compensated: "bg-amber-400",
  skipped: "bg-stone-300",
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
      <div className="rounded-lg border border-stone-200 bg-white p-4 text-[13px] text-stone-500">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white p-4 text-[13px] text-stone-500">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading workflow run…</span>
        </div>
      </div>
    );
  }

  const doneSteps = run.stepStates.filter((s) => s.status === "done").length;

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
      <div className="flex items-center justify-between border-b border-stone-200 bg-stone-50 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-[var(--brand-600)]" />
          <span className="text-sm font-semibold text-stone-900">
            {run.workflowName}
          </span>
          <span className="text-[12px] text-stone-500">
            run {run.runKey} · {doneSteps}/{run.stepStates.length} steps done
          </span>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
            STATUS_BADGE[run.status] ?? STATUS_BADGE.running
          }`}
        >
          {run.status}
        </span>
      </div>
      <ul className="divide-y divide-stone-100">
        {run.stepStates.map((s) => (
          <li key={s.name} className="flex items-center gap-3 px-4 py-2 text-[13px]">
            <span className={`h-2 w-2 shrink-0 rounded-full ${STEP_DOT[s.status] ?? STEP_DOT.pending}`} />
            <span className="font-medium text-stone-900">{s.name}</span>
            <span className="text-[12px] text-stone-500">{s.status}</span>
            {s.errorMessage && <span className="truncate text-[12px] text-rose-700">{s.errorMessage}</span>}
          </li>
        ))}
      </ul>
      {run.failure && (
        <div className="border-t border-rose-100 bg-rose-50 px-4 py-2 text-[12px] text-rose-800">
          Failed at step {run.failure.step}: {run.failure.errorMessage}
        </div>
      )}
      {run.compensationLog.length > 0 && (
        <div className="border-t border-stone-200 px-4 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-stone-700">
            <Undo2 className="h-3.5 w-3.5" />
            Rollback log
          </div>
          <ul className="space-y-0.5 text-[12px] text-stone-600">
            {run.compensationLog.map((c, i) => (
              <li key={i}>
                <span className={c.ok ? "text-stone-700" : "text-rose-700"}>
                  {c.ok ? "✓" : "✗"} {c.step} → {c.action}
                </span>
                {c.detail && <span className="text-stone-500"> — {c.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
