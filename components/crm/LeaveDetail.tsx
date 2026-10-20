// Marketr CRM — leave request detail slide-over (Phase 17 slice 5).
// Lifecycle: requested → approved / denied → taken.
// Approve is gated (Phase 14 approval card inline); deny and taken are
// free writes. Terminal: denied, taken.

"use client";

import { useState } from "react";
import { Ban, Check, Loader2, Undo2, X } from "lucide-react";
import {
  LEAVE_STATUS_META,
  LEAVE_TYPE_LABEL,
  fmtDate,
  type OpsLeaveRequest,
} from "./TeamTab";
import { OpsApprovalCard, decideOpsApproval, type OpsPendingGate } from "./OpsApprovalCard";
import { backdropCls, btnGhost, btnPrimary, chipCls, errorBoxCls, noteBoxCls, slideoverCls } from "./ui";

interface PendingLeave extends OpsPendingGate {
  toStatus: "approved";
}

function shortLeaveId(id: string): string {
  return id.slice(-6).toUpperCase();
}

export function LeaveDetail({
  leave,
  memberName,
  onClose,
  onChanged,
}: {
  leave: OpsLeaveRequest;
  memberName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<PendingLeave | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const meta = LEAVE_STATUS_META[leave.status] ?? LEAVE_STATUS_META.requested!;

  async function transition(to: "approved" | "denied" | "taken", approvalId?: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await fetch("/api/ops/leave-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: leave.id, status: to, ...(approvalId ? { approvalId } : {}) }),
      });
      const d = await r.json();
      if (r.status === 202 && d.approval_required) {
        setPending({
          approvalId: d.approval.id as string,
          tier: (d.approval.riskTier as string) ?? "medium",
          actionLabel: (d.classification?.label as string) ?? "Approve leave request",
          summary: `${(d.classification?.label as string) ?? "Approve leave request"} — ${LEAVE_TYPE_LABEL[leave.type] ?? leave.type} leave for ${memberName}, ${fmtDate(leave.startDate)} → ${fmtDate(leave.endDate)}.`,
          approved: false,
          toStatus: "approved",
        });
      } else if (!r.ok) {
        throw new Error(d.error ?? "Request failed.");
      } else {
        setNote(`Done — leave request is now ${to}.`);
        onChanged();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "approved" | "denied") {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await decideOpsApproval(pending.approvalId, decision);
      if (decision === "denied") {
        setPending(null);
        setNote("Denied — nothing was executed.");
      } else {
        setPending({ ...pending, approved: true });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed.");
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!pending || !pending.approved) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/ops/leave-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: leave.id, status: pending.toStatus, approvalId: pending.approvalId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Execution failed.");
      setPending(null);
      setNote("Done — leave request is now approved.");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Execution failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={backdropCls} onClick={onClose} aria-hidden />
      <div className={slideoverCls}>
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between border-b border-line px-5 py-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold tracking-tight text-ink">
                  {memberName} · leave
                </h3>
                <span className={chipCls}>
                  {meta.label}
                </span>
              </div>
              <p className="mt-0.5 text-[0.8125rem] text-muted">
                {LEAVE_TYPE_LABEL[leave.type] ?? leave.type} · {fmtDate(leave.startDate)} → {fmtDate(leave.endDate)} · #{shortLeaveId(leave.id)}
              </p>
            </div>
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {error && (
              <div className={`${errorBoxCls} mb-3`}>
                {error}
              </div>
            )}
            {note && (
              <div className={`${noteBoxCls} mb-3`}>
                {note}
              </div>
            )}

            {pending && (
              <OpsApprovalCard
                pending={pending}
                busy={busy}
                executeLabel={pending.actionLabel}
                onApprove={() => decide("approved")}
                onDeny={() => decide("denied")}
                onExecute={execute}
              />
            )}

            {/* Lifecycle actions */}
            <div className="mb-4 flex flex-wrap gap-2">
              {leave.status === "requested" && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => transition("approved")}
                    className={btnPrimary}
                  >
                    <Check size={14} /> Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => transition("denied")}
                    className={btnGhost}
                  >
                    <Ban size={14} /> Deny
                  </button>
                </>
              )}
              {leave.status === "approved" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => transition("taken")}
                  className={btnGhost}
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />} Mark taken
                </button>
              )}
              {(leave.status === "denied" || leave.status === "taken") && (
                <p className="text-[0.8125rem] text-muted">This request is closed — no further transitions.</p>
              )}
            </div>

            <div className="rounded-md border border-line bg-canvas px-3 py-2.5 text-[0.8125rem] text-muted">
              <p>
                Approving goes to a manager&apos;s approval (Phase 14 gate) and records who decided
                and when. Denying and marking taken apply immediately.
              </p>
              {leave.decidedAt && (
                <p className="mt-1 text-muted">Decided {fmtDate(leave.decidedAt)}.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
