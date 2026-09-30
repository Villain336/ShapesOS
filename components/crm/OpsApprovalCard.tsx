// Marketr CRM — shared Phase 14 approval card for Operations gated writes
// (Phase 17 slice 3). Same pattern as the invoice detail's inline card:
// propose → approve/deny inline (or in the Actions queue) → execute.

"use client";

import { Check, ExternalLink, Loader2, ShieldAlert } from "lucide-react";

export interface OpsPendingGate {
  approvalId: string;
  tier: string;
  actionLabel: string;
  summary: string;
  approved: boolean;
}

export function OpsApprovalCard({
  pending,
  busy,
  executeLabel,
  onApprove,
  onDeny,
  onExecute,
}: {
  pending: OpsPendingGate;
  busy: boolean;
  /** Label for the post-approval execute button, e.g. "Send purchase order". */
  executeLabel: string;
  onApprove: () => void;
  onDeny: () => void;
  onExecute: () => void;
}) {
  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] font-bold text-amber-900">
        <ShieldAlert size={16} /> Approval needed — {pending.actionLabel}
      </div>
      <p className="mt-1 text-[13px] text-amber-900">{pending.summary}</p>
      <p className="mt-1 text-[12px] text-amber-700">
        Risk tier: {pending.tier}. Nothing executes until you approve — approve here or in the
        Actions queue.
      </p>
      {!pending.approved ? (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onApprove}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDeny}
            className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-[13px] font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-50"
          >
            Deny
          </button>
          <a
            href="/dashboard/actions"
            className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--brand-700)] hover:underline"
          >
            Open Actions queue <ExternalLink size={12} />
          </a>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-green-700">
            <Check size={14} /> Approved
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={onExecute}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
          >
            {busy && <Loader2 size={14} className="animate-spin" />} {executeLabel}
          </button>
        </div>
      )}
    </div>
  );
}

/** POST a decision to the Phase 14 approvals endpoint. Shared by ops UIs. */
export async function decideOpsApproval(
  approvalId: string,
  decision: "approved" | "denied",
): Promise<void> {
  const r = await fetch(`/api/integrations/actions/approvals/${approvalId}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "Decision failed.");
}
