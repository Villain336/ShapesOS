// Marketr — approvals inbox (Phase 9 M6).
// Dense table of pending approvals across all missions for this workspace,
// with large touch-target Approve/Deny buttons (min 44px, usable at 390px).
// Decides via POST /api/automation/decide — the same contract as M4's
// POST /api/missions/:id/approvals/:approvalId/decide ({ decision }).

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Inbox,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";

type Tier = 0 | 1 | 2 | 3;

interface PendingApproval {
  id: string;
  missionId: string | null;
  missionTemplate: string | null;
  action: string;
  tier: number;
  amountCents: number | null;
  payloadSummary: string;
  bindingHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

function TierBadge({ tier }: { tier: number }) {
  const t = (tier === 0 || tier === 1 || tier === 2 || tier === 3 ? tier : 2) as Tier;
  const tones: Record<Tier, string> = {
    0: "bg-slate-100 text-slate-600 border-slate-200",
    1: "bg-violet-50 text-violet-700 border-violet-200",
    2: "bg-amber-50 text-amber-700 border-amber-200",
    3: "bg-red-50 text-red-700 border-red-200",
  };
  const labels: Record<Tier, string> = {
    0: "Tier 0",
    1: "Tier 1",
    2: "Tier 2",
    3: "Tier 3",
  };
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[t]}`}
    >
      {labels[t]}
    </span>
  );
}

function ageOf(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function fmtAmount(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export default function ApprovalsInbox() {
  const [approvals, setApprovals] = useState<PendingApproval[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/automation/pending");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load approvals.");
      setApprovals(body.approvals as PendingApproval[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load approvals.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(approval: PendingApproval, decision: "approved" | "denied") {
    setBusyId(approval.id);
    setError(null);
    try {
      const res = await fetch("/api/automation/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId: approval.id,
          missionId: approval.missionId,
          decision,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Decision failed.");
      setApprovals((prev) => (prev ?? []).filter((a) => a.id !== approval.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed.");
    } finally {
      setBusyId(null);
    }
  }

  if (approvals === null) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-stone-500">
        <Loader2 size={16} className="animate-spin" />
        Loading pending approvals…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-stone-500">
          {approvals.length === 0
            ? "Nothing waiting on you."
            : `${approvals.length} pending — newest first.`}
        </p>
        <button
          onClick={load}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 text-[13px] font-medium text-stone-600 hover:text-stone-900"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          <AlertTriangle size={15} className="shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto" aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}

      {approvals.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-stone-200 bg-white px-6 py-12 text-center">
          <CheckCircle2 size={28} className="text-stone-300" />
          <div className="text-[14px] font-semibold text-stone-900">All caught up</div>
          <div className="max-w-[320px] text-[13px] text-stone-500">
            No pending approvals. When a mission needs your sign-off, it will appear here.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="min-w-[760px] w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">Mission</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Tier</th>
                <th className="px-3 py-2 font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Age</th>
                <th className="px-3 py-2 font-medium">Payload</th>
                <th className="px-3 py-2 text-right font-medium">Decision</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((a) => {
                const busy = busyId === a.id;
                return (
                  <tr
                    key={a.id}
                    className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40"
                  >
                    <td className="max-w-[160px] px-3 py-2.5 align-top">
                      <div className="truncate font-medium text-stone-900" title={a.missionTemplate ?? "No mission"}>
                        {a.missionTemplate ?? (
                          <span className="inline-flex items-center gap-1 text-stone-400">
                            <Inbox size={12} />
                            No mission
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-stone-400">{a.id.slice(0, 12)}…</div>
                    </td>
                    <td className="max-w-[180px] px-3 py-2.5 align-top">
                      <div className="truncate font-mono text-[12px] text-stone-800" title={a.action}>
                        {a.action}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <TierBadge tier={a.tier} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-top font-medium text-stone-800">
                      {fmtAmount(a.amountCents)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-top text-stone-500">
                      {ageOf(a.createdAt)}
                    </td>
                    <td className="max-w-[220px] px-3 py-2.5 align-top">
                      <div className="truncate text-[12px] text-stone-500" title={a.payloadSummary || a.bindingHash}>
                        {a.payloadSummary || (
                          <span className="font-mono text-[11px]">{a.bindingHash.slice(0, 16)}…</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => decide(a, "approved")}
                          disabled={busy}
                          aria-label={`Approve ${a.action}`}
                          className="flex h-11 min-w-[88px] items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                        >
                          {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                          Approve
                        </button>
                        <button
                          onClick={() => decide(a, "denied")}
                          disabled={busy}
                          aria-label={`Deny ${a.action}`}
                          className="flex h-11 min-w-[88px] items-center justify-center gap-1.5 rounded-lg border border-stone-300 px-4 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                        >
                          <X size={15} />
                          Deny
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[12px] text-stone-500">
        Approving binds the exact payload the mission proposed — the executor re-verifies it at
        execution time and halts on any mismatch. Every decision is written to the hash-chained
        approval event trail.
      </p>
    </div>
  );
}
