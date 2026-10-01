// Marketr — approvals inbox (Phase 9 M6).
// Dense table of pending approvals across all missions for this workspace,
// with large touch-target Approve/Deny buttons (min 44px, usable at 390px).
// Decides via POST /api/automation/decide — the same contract as M4's
// POST /api/missions/:id/approvals/:approvalId/decide ({ decision }).

"use client";

import { useCallback, useEffect, useState } from "react";
import {
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

// Tiers are categories, not agent states — always a neutral chip.
function TierBadge({ tier }: { tier: number }) {
  const t = (tier === 0 || tier === 1 || tier === 2 || tier === 3 ? tier : 2) as Tier;
  const labels: Record<Tier, string> = {
    0: "Tier 0",
    1: "Tier 1",
    2: "Tier 2",
    3: "Tier 3",
  };
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">
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

const btnApprove =
  "flex h-11 min-w-[88px] items-center justify-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press disabled:opacity-40";

const btnDeny =
  "flex h-11 min-w-[88px] items-center justify-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text aos-press shadow-[inset_0_0_0_1.5px_var(--aos-failed)] disabled:opacity-40";

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
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="aos-spin" />
        Loading pending approvals…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {approvals.length > 0 && (
        <div
          role="status"
          className="flex items-center gap-2.5 rounded-lg bg-needs px-4 py-3 text-ink"
        >
          <span
            className="aos-shape aos-shape--needs [--aos-shape-size:14px]"
            style={{ color: "inherit" }}
            aria-hidden
          />
          <p className="text-sm font-semibold">
            {approvals.length} approval{approvals.length === 1 ? "" : "s"} waiting on your
            sign-off — newest first.
          </p>
          <button
            onClick={load}
            className="ml-auto inline-flex h-chip shrink-0 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
        >
          <span className="size-2.5 shrink-0 rounded-[2px] bg-failed" aria-hidden />
          {error}
          <button onClick={() => setError(null)} className="ml-auto" aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}

      {approvals.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg bg-paper px-6 py-12 text-center shadow-hairline">
          <CheckCircle2 size={28} className="text-subtle" />
          <div className="text-sm font-semibold text-ink">All caught up</div>
          <div className="max-w-[320px] text-sm text-muted">
            No pending approvals. When a mission needs your sign-off, it will appear here.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
          <table className="min-w-[760px] w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2 font-semibold">Mission</th>
                <th className="px-3 py-2 font-semibold">Action</th>
                <th className="px-3 py-2 font-semibold">Tier</th>
                <th className="px-3 py-2 font-semibold">Amount</th>
                <th className="px-3 py-2 font-semibold">Age</th>
                <th className="px-3 py-2 font-semibold">Payload</th>
                <th className="px-3 py-2 text-right font-semibold">Decision</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((a) => {
                const busy = busyId === a.id;
                return (
                  <tr
                    key={a.id}
                    className="border-b border-line last:border-0 hover:bg-hover-paper"
                  >
                    <td className="max-w-[160px] px-3 py-2.5 align-top">
                      <div className="truncate font-medium text-ink" title={a.missionTemplate ?? "No mission"}>
                        {a.missionTemplate ?? (
                          <span className="inline-flex items-center gap-1 text-subtle">
                            <Inbox size={12} />
                            No mission
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-xs text-subtle">{a.id.slice(0, 12)}…</div>
                    </td>
                    <td className="max-w-[180px] px-3 py-2.5 align-top">
                      <div className="truncate font-mono text-[12px] text-ink" title={a.action}>
                        {a.action}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <TierBadge tier={a.tier} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-top font-medium text-ink">
                      {fmtAmount(a.amountCents)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-top text-muted">
                      {ageOf(a.createdAt)}
                    </td>
                    <td className="max-w-[220px] px-3 py-2.5 align-top">
                      <div className="truncate text-xs text-muted" title={a.payloadSummary || a.bindingHash}>
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
                          className={btnApprove}
                        >
                          {busy ? <Loader2 size={15} className="aos-spin" /> : <Check size={15} />}
                          Approve
                        </button>
                        <button
                          onClick={() => decide(a, "denied")}
                          disabled={busy}
                          aria-label={`Deny ${a.action}`}
                          className={btnDeny}
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

      <p className="text-xs text-muted">
        Approving binds the exact payload the mission proposed — the executor re-verifies it at
        execution time and halts on any mismatch. Every decision is written to the hash-chained
        approval event trail.
      </p>
    </div>
  );
}
