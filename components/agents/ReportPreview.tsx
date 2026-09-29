// Marketr — Phase 16 slice 9: ReportPreview, a registered generative component.
//
// Renders a pending ReportSendApproval in-flow (agent emits only { approvalId };
// the card loads live data from the gate). Shows every figure WITH its source
// pointer — the never-invent-numbers guardrail is visible in the UI: figures
// without a source render as flagged badges, never as numbers.
//
// Gate law: Approve/Deny/Edit execute through the Phase 14 gate's own service
// functions via the API routes — the card never reimplements approval logic,
// and every action writes an audit entry (the gate's service functions do that).
//
// House pattern: --brand-600/700/50 vars, never hardcoded primaries; Lucide
// icons only; dense tables for the figure list.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  FileText,
  Loader2,
  Pencil,
  ShieldCheck,
  X,
} from "lucide-react";

export interface ReportPreviewProps {
  /** ReportSendApproval id (the agent emits this; never agent-invented content). */
  approvalId: string;
  /** Called after a decision lands (approved/denied/edited). */
  onResolved?: (decision: "approved" | "denied" | "edited", approvalId: string) => void;
}

interface PreviewFigure {
  key: string;
  label: string;
  value: string;
  delta?: string;
  source?: { provider: string; ref: string; capturedAt?: string } | null;
}

interface PreviewApproval {
  id: string;
  templateName: string;
  templateVersion: string;
  clientName: string;
  period: string;
  payload: { meta?: Record<string, string>; figures?: PreviewFigure[] } | null;
  status: string;
  reviewNote: string | null;
  pdfPath: string | null;
  brandKit: { id: string; name: string } | null;
  createdAt: string;
}

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-stone-100 text-stone-700 border-stone-200",
  flagged: "bg-amber-50 text-amber-800 border-amber-200",
  approved: "bg-[var(--brand-50)] text-[var(--brand-700)] border-[var(--brand-600)]/30",
  denied: "bg-rose-50 text-rose-800 border-rose-200",
  rendered: "bg-emerald-50 text-emerald-800 border-emerald-200",
  failed: "bg-rose-50 text-rose-800 border-rose-200",
};

type CardPhase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready" }
  | { kind: "editing" }
  | { kind: "working"; label: string }
  | { kind: "done"; decision: "approved" | "denied" | "edited"; message: string };

export function ReportPreview({ approvalId, onResolved }: ReportPreviewProps) {
  const [approval, setApproval] = useState<PreviewApproval | null>(null);
  const [phase, setPhase] = useState<CardPhase>({ kind: "loading" });
  const [editPeriod, setEditPeriod] = useState("");
  const [denyNote, setDenyNote] = useState("");
  const [showDeny, setShowDeny] = useState(false);

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const res = await fetch(`/api/reports/send-approvals/${encodeURIComponent(approvalId)}`);
      const body = (await res.json()) as { approval?: PreviewApproval; error?: string };
      if (!res.ok || !body.approval) throw new Error(body.error ?? "Failed to load report");
      setApproval(body.approval);
      setEditPeriod(body.approval.period);
      setPhase({ kind: "ready" });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Failed to load report" });
    }
  }, [approvalId]);

  useEffect(() => {
    void load();
  }, [load]);

  const postDecision = useCallback(
    async (path: "approve" | "deny" | "edit", body: Record<string, unknown>, label: string) => {
      setPhase({ kind: "working", label });
      try {
        const res = await fetch(`/api/reports/send-approvals/${encodeURIComponent(approvalId)}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await res.json()) as { ok?: boolean; error?: string; ungroundedKeys?: string[] };
        if (!res.ok || !payload.ok) {
          const extra = payload.ungroundedKeys?.length
            ? ` (missing sources: ${payload.ungroundedKeys.join(", ")})`
            : "";
          throw new Error((payload.error ?? `${label} failed`) + extra);
        }
        const decision = path === "approve" ? "approved" : path === "deny" ? "denied" : "edited";
        setPhase({
          kind: "done",
          decision,
          message:
            decision === "edited"
              ? "Saved — still pending approval."
              : decision === "approved"
                ? "Approved and rendered to PDF."
                : "Report denied.",
        });
        onResolved?.(decision, approvalId);
        void load();
      } catch (err) {
        setPhase({ kind: "error", message: err instanceof Error ? err.message : `${label} failed` });
      }
    },
    [approvalId, onResolved, load],
  );

  const figures = approval?.payload?.figures ?? [];
  const ungrounded = figures.filter((f) => !f.source?.provider || !f.source?.ref);
  const actionable = approval && (approval.status === "pending" || approval.status === "flagged");

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-[var(--brand-600)]" />
          <div>
            <div className="text-sm font-semibold text-stone-900">
              {approval ? `Report: ${approval.clientName}` : "Report preview"}
            </div>
            {approval && (
              <div className="text-xs text-stone-500">
                {approval.templateName}@{approval.templateVersion} · {approval.period}
                {approval.brandKit ? ` · ${approval.brandKit.name}` : " · default brand"}
              </div>
            )}
          </div>
        </div>
        {approval && (
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE[approval.status] ?? STATUS_BADGE.pending}`}
          >
            {approval.status === "flagged" && <AlertTriangle className="h-3 w-3" />}
            {approval.status}
          </span>
        )}
      </div>

      {phase.kind === "loading" && (
        <div className="flex items-center gap-2 py-6 text-sm text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading report…
        </div>
      )}

      {phase.kind === "error" && (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {phase.message}{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {phase.kind === "working" && (
        <div className="flex items-center gap-2 py-6 text-sm text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" /> {phase.label}…
        </div>
      )}

      {phase.kind === "done" && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
          {phase.decision === "approved" ? (
            <ShieldCheck className="h-4 w-4 text-[var(--brand-600)]" />
          ) : phase.decision === "denied" ? (
            <X className="h-4 w-4 text-rose-600" />
          ) : (
            <Pencil className="h-4 w-4 text-stone-500" />
          )}
          {phase.message}
        </div>
      )}

      {(phase.kind === "ready" || phase.kind === "editing") && approval && (
        <>
          {approval.reviewNote && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{approval.reviewNote}</span>
            </div>
          )}

          <table className="mt-3 w-full text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 text-left text-[11px] uppercase tracking-wide text-stone-500">
                <th className="py-1.5 pr-2 font-medium">Figure</th>
                <th className="py-1.5 pr-2 font-medium">Value</th>
                <th className="py-1.5 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {figures.map((f) => {
                const grounded = f.source?.provider && f.source?.ref;
                return (
                  <tr key={f.key} className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                    <td className="py-2 pr-2 font-medium text-stone-900">{f.label}</td>
                    <td className="py-2 pr-2 text-stone-700">
                      {grounded ? (
                        <>
                          {f.value}
                          {f.delta && <span className="ml-1.5 text-xs text-[var(--brand-700)]">{f.delta}</span>}
                        </>
                      ) : (
                        <span className="text-stone-400">— withheld (no source)</span>
                      )}
                    </td>
                    <td className="py-2">
                      {grounded ? (
                        <span className="text-xs text-stone-500">
                          {f.source!.provider} · {f.source!.ref}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                          <AlertTriangle className="h-3 w-3" /> no source — flagged
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {ungrounded.length > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              {ungrounded.length} figure{ungrounded.length === 1 ? "" : "s"} missing {ungrounded.length === 1 ? "a" : ""} source —{" "}
              {ungrounded.length === 1 ? "it is" : "they are"} withheld from the PDF until sourced.
            </p>
          )}

          {actionable && phase.kind === "ready" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void postDecision("approve", {}, "Approving and rendering")}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)]"
              >
                <Check className="h-3.5 w-3.5" /> Approve &amp; render
              </button>
              <button
                type="button"
                onClick={() => setShowDeny((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 px-3 py-1.5 text-[13px] font-medium text-stone-700 hover:bg-stone-50"
              >
                <X className="h-3.5 w-3.5" /> Deny
              </button>
              <button
                type="button"
                onClick={() => setPhase({ kind: "editing" })}
                className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 px-3 py-1.5 text-[13px] font-medium text-stone-700 hover:bg-stone-50"
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            </div>
          )}

          {actionable && showDeny && phase.kind === "ready" && (
            <div className="mt-2 flex items-center gap-2">
              <input
                value={denyNote}
                onChange={(e) => setDenyNote(e.target.value)}
                placeholder="Denial note (optional)"
                className="flex-1 rounded-md border border-stone-200 px-2.5 py-1.5 text-[13px]"
              />
              <button
                type="button"
                onClick={() => void postDecision("deny", { note: denyNote }, "Denying")}
                className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-[13px] font-medium text-rose-700 hover:bg-rose-100"
              >
                Confirm deny
              </button>
            </div>
          )}

          {actionable && phase.kind === "editing" && (
            <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-3">
              <label className="block text-xs font-medium text-stone-600">Reporting period</label>
              <input
                value={editPeriod}
                onChange={(e) => setEditPeriod(e.target.value)}
                className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px]"
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void postDecision("edit", { period: editPeriod }, "Saving edit")}
                  className="rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)]"
                >
                  Save — requeue for approval
                </button>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: "ready" })}
                  className="rounded-md border border-stone-200 px-3 py-1.5 text-[13px] text-stone-600 hover:bg-white"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
