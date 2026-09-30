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

const RUN_STATUS_META: Record<string, { label: string; tint: string }> = {
  running: { label: "Running", tint: "bg-blue-100 text-blue-700" },
  succeeded: { label: "Succeeded", tint: "bg-green-100 text-green-700" },
  failed: { label: "Failed — needs attention", tint: "bg-red-100 text-red-700" },
  compensated: { label: "Failed — compensated", tint: "bg-amber-100 text-amber-700" },
};

const STEP_STATUS_META: Record<string, { label: string; tint: string }> = {
  pending: { label: "Pending", tint: "bg-stone-200 text-stone-600" },
  running: { label: "Running", tint: "bg-blue-100 text-blue-700" },
  done: { label: "Done", tint: "bg-green-100 text-green-700" },
  failed: { label: "Failed", tint: "bg-red-100 text-red-700" },
  compensated: { label: "Compensated", tint: "bg-amber-100 text-amber-700" },
};

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
    <div className="bg-[#FAFAF7] p-4 md:p-6">
      <div className="mb-1 flex items-center gap-2">
        <Workflow className="h-5 w-5 text-[var(--brand-600)]" />
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Workflows</h1>
      </div>
      <p className="mb-4 text-[13px] text-stone-500">
        Long-running operations run as workflows with transactional semantics: steps execute in
        order, and when a step fails the completed steps are compensated (rolled back) in reverse
        order. Money-moving runs are pre-authorized once — the approval binds the full step plan
        and the rollback plan.
      </p>

      {/* Launcher */}
      <div className="mb-6 rounded-lg border border-stone-200 bg-white p-4">
        <h2 className="mb-1 text-[14px] font-semibold text-stone-900">
          Run: Order → payment → fulfillment
        </h2>
        <p className="mb-3 text-[13px] text-stone-500">
          Confirms a draft order, records the Stripe charge, then fulfills the order. If a step
          fails, the charge is refunded and the order cancelled automatically — no new approval
          needed mid-rollback.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            placeholder="Order id (e.g. ord_…)"
            className="w-64 rounded-lg border border-stone-300 bg-white px-3 py-[7px] text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none"
          />
          <button
            type="button"
            disabled={launchBusy || !!pending}
            onClick={propose}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3 py-[7px] text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
          >
            <Play className="h-4 w-4" />
            Propose run
          </button>
        </div>
        {launchError && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
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
          <div className="mt-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-[13px] text-green-800">
            Run finished: {RUN_STATUS_META[lastRun.status]?.label ?? lastRun.status} —{" "}
            {(lastRun.compensationLog ?? []).length} compensation entr
            {(lastRun.compensationLog ?? []).length === 1 ? "y" : "ies"}.
          </div>
        )}
      </div>

      {/* Runs table */}
      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="crm-table w-full min-w-[860px]">
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
                <td colSpan={6} className="py-6 text-center text-[13px] text-stone-400">
                  Loading runs…
                </td>
              </tr>
            ) : runs.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-6 text-center text-[13px] text-stone-400">
                  No workflow runs yet.
                </td>
              </tr>
            ) : (
              runs.map((run) => {
                const meta = RUN_STATUS_META[run.status] ?? RUN_STATUS_META.running!;
                const steps = run.steps ?? [];
                const done = steps.filter((s) => s.status === "done").length;
                const comps = run.compensationLog ?? [];
                return (
                  <tr
                    key={run.id}
                    onClick={() => setSelectedId(run.id)}
                    className="cursor-pointer hover:bg-[var(--brand-50)]/40"
                  >
                    <td className="font-semibold text-stone-900">{run.workflowName}</td>
                    <td className="font-mono text-[12px] text-stone-500">
                      {run.runKey ? run.runKey.slice(0, 8) : "—"}
                    </td>
                    <td>
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.tint}`}
                      >
                        {meta.label}
                      </span>
                    </td>
                    <td className="tabular-nums text-stone-600">
                      {done}/{steps.length}
                    </td>
                    <td className="tabular-nums text-stone-600">{comps.length}</td>
                    <td className="text-stone-500">{fmtDate(run.createdAt)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {/* Detail slide-over */}
      {selected && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div className="absolute inset-0 bg-black/30" onClick={() => setSelectedId(null)} />
          <div className="relative flex h-full w-full max-w-md flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
              <div>
                <h3 className="text-[15px] font-bold text-stone-900">{selected.workflowName}</h3>
                <p className="text-[12px] text-stone-500">
                  Run key {selected.runKey ? selected.runKey.slice(0, 8) : "—"} ·{" "}
                  {fmtDate(selected.createdAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-100"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[13px] font-semibold text-stone-900">Status</span>
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    (RUN_STATUS_META[selected.status] ?? RUN_STATUS_META.running!).tint
                  }`}
                >
                  {(RUN_STATUS_META[selected.status] ?? RUN_STATUS_META.running!).label}
                </span>
              </div>
              <h4 className="mb-2 mt-4 text-[13px] font-semibold text-stone-900">Steps</h4>
              <ol className="space-y-2">
                {(selected.steps ?? []).map((s, i) => {
                  const sm = STEP_STATUS_META[s.status] ?? STEP_STATUS_META.pending!;
                  return (
                    <li
                      key={`${s.name}-${i}`}
                      className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[12px] font-semibold text-stone-800">
                          {i + 1}. {s.name}
                        </span>
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${sm.tint}`}
                        >
                          {sm.label}
                        </span>
                      </div>
                      {s.at && <div className="mt-1 text-[11px] text-stone-400">{fmtDate(s.at)}</div>}
                    </li>
                  );
                })}
              </ol>
              <h4 className="mb-2 mt-4 text-[13px] font-semibold text-stone-900">
                Compensation log
              </h4>
              {(selected.compensationLog ?? []).length === 0 ? (
                <p className="text-[13px] text-stone-400">No compensations — every step succeeded.</p>
              ) : (
                <ol className="space-y-2">
                  {(selected.compensationLog ?? []).map((c, i) => (
                    <li
                      key={i}
                      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
                    >
                      <div className="text-[12px] font-semibold text-amber-900">{c.step}</div>
                      <div className="text-[12px] text-amber-800">{c.action}</div>
                      {c.at && (
                        <div className="mt-1 text-[11px] text-amber-700/70">{fmtDate(c.at)}</div>
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
