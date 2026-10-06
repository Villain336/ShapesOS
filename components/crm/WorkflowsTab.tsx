// Marketr — Phase 17 slice 6: the Workflows tab.
//
// Dense table of OpsWorkflowRun records (step timeline + compensation log in
// the detail slide-over), plus the run launcher for the shipped workflow
// "order-payment-fulfillment": propose → 202 approval card (full step plan +
// rollback plan) → decide → execute under the pre-authorized approval.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Play, Workflow, X } from "lucide-react";
import { OpsApprovalCard, decideOpsApproval, type OpsPendingGate } from "./OpsApprovalCard";
import { RunStatusChip, StepStatusChip, btnPrimary, errorBoxCls, inputCls, noteBoxCls, tableCls, tableWrapCls, trClickableCls } from "./ui";
import { activateOnKey } from "@/lib/ui/keyboard";

interface RunStep {
  name: string;
  status: "pending" | "running" | "done" | "failed" | "compensated";
  at?: string;
  detail?: Record<string, unknown>;
}

interface CompEntry {
  step: string;
  action: string;
  at?: string;
  result?: unknown;
}

interface WorkflowRun {
  id: string;
  workflowName: string;
  runKey: string | null;
  steps: RunStep[];
  compensationLog: CompEntry[];
  status: "running" | "succeeded" | "failed" | "compensated";
  createdAt: string;
}

// (plan/rollback-plan types live server-side; the card shows the summary)

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function WorkflowsTab() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Launcher state
  const [orderId, setOrderId] = useState("");
  const [launchBusy, setLaunchBusy] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [pending, setPending] = useState<
    (OpsPendingGate & { runKey: string; inputs: Record<string, unknown> }) | null
  >(null);
  const [lastRun, setLastRun] = useState<WorkflowRun | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/ops/workflow-runs?limit=50");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to load workflow runs.");
      setRuns((d.rows as WorkflowRun[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load workflow runs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(() => runs.find((r) => r.id === selectedId) ?? null, [runs, selectedId]);

  async function propose() {
    if (!orderId.trim()) {
      setLaunchError("Enter an order id to run the workflow against.");
      return;
    }
    setLaunchBusy(true);
    setLaunchError(null);
    setLastRun(null);
    try {
      const runKey = crypto.randomUUID();
      const inputs = { orderId: orderId.trim() };
      const r = await fetch("/api/ops/workflows/order-payment-fulfillment/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs, runKey }),
      });
      const d = await r.json();
      if (r.status === 202 && d.approval_required) {
        setPending({
          approvalId: d.approval.id as string,
          tier: (d.approval.riskTier as string) ?? "medium",
          actionLabel: `Run workflow "${d.label as string}"`,
          summary: d.summary as string,
          approved: false,
          runKey,
          inputs,
        });
      } else if (!r.ok) {
        throw new Error(d.error ?? "Workflow propose failed.");
      } else {
        throw new Error("Unexpected response from the workflow runner.");
      }
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : "Workflow propose failed.");
    } finally {
      setLaunchBusy(false);
    }
  }

  async function decide(decision: "approved" | "denied") {
    if (!pending) return;
    setLaunchBusy(true);
    setLaunchError(null);
    try {
      await decideOpsApproval(pending.approvalId, decision);
      if (decision === "denied") {
        setPending(null);
        setLaunchError("Denied — nothing was executed.");
      } else {
        setPending({ ...pending, approved: true });
      }
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : "Decision failed.");
    } finally {
      setLaunchBusy(false);
    }
  }

  async function execute() {
    if (!pending || !pending.approved) return;
    setLaunchBusy(true);
    setLaunchError(null);
    try {
      const r = await fetch("/api/ops/workflows/order-payment-fulfillment/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: pending.inputs,
          runKey: pending.runKey,
          approvalId: pending.approvalId,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Workflow execution failed.");
      setPending(null);
      setLastRun(d.run as WorkflowRun);
      await refresh();
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : "Workflow execution failed.");
    } finally {
      setLaunchBusy(false);
    }
  }

  return (
    <div className="bg-canvas p-4 md:p-6">
      <div className="mb-1 flex items-center gap-2">
        <Workflow className="h-5 w-5 text-ink" />
        <h1 className="text-xl font-bold tracking-tight text-ink">Workflows</h1>
      </div>
      <p className="mb-4 text-[0.8125rem] text-muted">
        Long-running operations run as workflows with transactional semantics: steps execute in
        order, and when a step fails the completed steps are compensated (rolled back) in reverse
        order. Money-moving runs are pre-authorized once — the approval binds the full step plan
        and the rollback plan.
      </p>

      {/* Launcher */}
      <div className="mb-6 rounded-md border border-line bg-paper p-4">
        <h2 className="mb-1 text-[0.875rem] font-semibold text-ink">
          Run: Order → payment → fulfillment
        </h2>
        <p className="mb-3 text-[0.8125rem] text-muted">
          Confirms a draft order, records the Stripe charge, then fulfills the order. If a step
          fails, the charge is refunded and the order cancelled automatically — no new approval
          needed mid-rollback.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            placeholder="Order id (e.g. ord_…)"
            className={`${inputCls} w-64`}
          />
          <button
            type="button"
            disabled={launchBusy || !!pending}
            onClick={propose}
            className={btnPrimary}
          >
            <Play className="h-4 w-4" />
            Propose run
          </button>
        </div>
        {launchError && (
          <div className={`${errorBoxCls} mt-3`}>
            {launchError}
          </div>
        )}
        {pending && (
          <div className="mt-3">
            <OpsApprovalCard
              pending={pending}
              busy={launchBusy}
              executeLabel="Execute workflow"
              onApprove={() => decide("approved")}
              onDeny={() => decide("denied")}
              onExecute={execute}
            />
          </div>
        )}
        {lastRun && (
          <div className={`${noteBoxCls} mt-3`}>
            Run finished: {lastRun.status} —{" "}
            {(lastRun.compensationLog ?? []).length} compensation entr
            {(lastRun.compensationLog ?? []).length === 1 ? "y" : "ies"}.
          </div>
        )}
      </div>

      {/* Runs table */}
      <div className={tableWrapCls}>
        <table className={`${tableCls} min-w-[860px]`}>
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Run key</th>
              <th>Status</th>
              <th>Steps</th>
              <th>Compensations</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="py-6 text-center text-[0.8125rem] text-subtle">
                  Loading runs…
                </td>
              </tr>
            ) : runs.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-6 text-center text-[0.8125rem] text-subtle">
                  No workflow runs yet.
                </td>
              </tr>
            ) : (
              runs.map((run) => {
                const steps = run.steps ?? [];
                const done = steps.filter((s) => s.status === "done").length;
                const comps = run.compensationLog ?? [];
                return (
                  <tr
                    key={run.id}
                    onClick={() => setSelectedId(run.id)}
                    tabIndex={0}
                    onKeyDown={activateOnKey(() => setSelectedId(run.id))}
                    className={trClickableCls}
                  >
                    <td className="font-semibold text-ink">{run.workflowName}</td>
                    <td className="font-mono text-[0.75rem] text-muted">
                      {run.runKey ? run.runKey.slice(0, 8) : "—"}
                    </td>
                    <td>
                      <RunStatusChip status={run.status} />
                    </td>
                    <td className="tabular-nums text-muted">
                      {done}/{steps.length}
                    </td>
                    <td className="tabular-nums text-muted">{comps.length}</td>
                    <td className="text-muted">{fmtDate(run.createdAt)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {error && (
        <div className={`${errorBoxCls} mt-3`}>
          {error}
        </div>
      )}

      {/* Detail slide-over */}
      {selected && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div className="absolute inset-0 bg-black/30" onClick={() => setSelectedId(null)} aria-hidden />
          <div className="relative flex h-full w-full max-w-md flex-col bg-paper shadow-overlay">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <h3 className="text-[0.9375rem] font-bold text-ink">{selected.workflowName}</h3>
                <p className="text-[0.75rem] text-muted">
                  Run key {selected.runKey ? selected.runKey.slice(0, 8) : "—"} ·{" "}
                  {fmtDate(selected.createdAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="rounded-md p-1.5 text-muted hover:bg-hover-paper hover:text-ink"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[0.8125rem] font-semibold text-ink">Status</span>
                <RunStatusChip status={selected.status} />
              </div>
              <h4 className="mb-2 mt-4 text-[0.8125rem] font-semibold text-ink">Steps</h4>
              <ol className="space-y-2">
                {(selected.steps ?? []).map((s, i) => {
                  return (
                    <li
                      key={`${s.name}-${i}`}
                      className="rounded-md border border-line bg-canvas px-3 py-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[0.75rem] font-semibold text-ink">
                          {i + 1}. {s.name}
                        </span>
                        <StepStatusChip status={s.status} />
                      </div>
                      {s.at && <div className="mt-1 text-[0.6875rem] text-subtle">{fmtDate(s.at)}</div>}
                    </li>
                  );
                })}
              </ol>
              <h4 className="mb-2 mt-4 text-[0.8125rem] font-semibold text-ink">
                Compensation log
              </h4>
              {(selected.compensationLog ?? []).length === 0 ? (
                <p className="text-[0.8125rem] text-subtle">No compensations — every step succeeded.</p>
              ) : (
                <ol className="space-y-2">
                  {(selected.compensationLog ?? []).map((c, i) => (
                    <li
                      key={i}
                      className="rounded-md border border-line bg-canvas px-3 py-2"
                    >
                      <div className="text-[0.75rem] font-semibold text-ink">{c.step}</div>
                      <div className="text-[0.75rem] text-ink">{c.action}</div>
                      {c.at && (
                        <div className="mt-1 text-[0.6875rem] text-ink/70">{fmtDate(c.at)}</div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
