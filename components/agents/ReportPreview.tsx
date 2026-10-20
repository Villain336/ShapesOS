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
// Agentic OS: token classes only, black primary, Approve in done green, Deny as a
// failed-ring pill; Lucide icons only; dense tables for the figure list.

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

// Agent-prepared report awaiting human sign-off: genuine agent states, so
// they take the status fill + shape (needs you / done / failed). A denial is a
// human decision, not a run state, so it stays neutral.
const STATUS_BADGE: Record<string, string> = {
  pending: "bg-needs text-ink",
  flagged: "bg-needs text-ink",
  approved: "bg-done text-white",
  denied: "bg-canvas text-ink shadow-control",
  rendered: "bg-done text-white",
  failed: "bg-failed text-white",
};
const STATUS_SHAPE: Record<string, string | undefined> = {
  pending: "needs",
  flagged: "needs",
  approved: "done",
  rendered: "done",
  failed: "failed",
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
  // Unknown statuses fall back to the pending badge, so they take its shape too.
  const badgeShape = approval
    ? (STATUS_BADGE[approval.status] ? STATUS_SHAPE[approval.status] : STATUS_SHAPE.pending)
    : undefined;

  return (
    <div className="rounded-lg bg-paper shadow-hairline p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-ink" />
          <div>
            <div className="text-sm font-semibold text-ink">
              {approval ? `Report: ${approval.clientName}` : "Report preview"}
            </div>
            {approval && (
              <div className="text-xs text-muted">
                {approval.templateName}@{approval.templateVersion} · {approval.period}
                {approval.brandKit ? ` · ${approval.brandKit.name}` : " · default brand"}
              </div>
            )}
          </div>
        </div>
        {approval && (
          <span
            className={`inline-flex h-badge items-center gap-1.5 rounded-full px-2.5 text-[0.8125rem] font-semibold ${STATUS_BADGE[approval.status] ?? STATUS_BADGE.pending}`}
          >
            {badgeShape && (
              <span className={`aos-shape aos-shape--${badgeShape}`} style={{ color: "inherit" }} aria-hidden />
            )}
            {approval.status}
          </span>
        )}
      </div>

      {phase.kind === "loading" && (
        <div className="flex items-center gap-2 py-6 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading report…
        </div>
      )}

      {phase.kind === "error" && (
        <div className="mt-3 rounded-md border border-failed bg-failed-tint p-3 text-sm text-failed-text">
          {phase.message}{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {phase.kind === "working" && (
        <div className="flex items-center gap-2 py-6 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> {phase.label}…
        </div>
      )}

      {phase.kind === "done" && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-line bg-canvas p-3 text-sm text-ink">
          {phase.decision === "approved" ? (
            <ShieldCheck className="h-4 w-4 text-ink" />
          ) : phase.decision === "denied" ? (
            <X className="h-4 w-4 text-failed-text" />
          ) : (
            <Pencil className="h-4 w-4 text-muted" />
          )}
          {phase.message}
        </div>
      )}

      {(phase.kind === "ready" || phase.kind === "editing") && approval && (
        <>
          {approval.reviewNote && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-needs bg-needs-tint p-3 text-[0.8125rem] text-ink">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{approval.reviewNote}</span>
            </div>
          )}

          <table className="mt-3 w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line text-left text-[0.6875rem] text-muted">
                <th className="py-1.5 pr-2 font-medium">Figure</th>
                <th className="py-1.5 pr-2 font-medium">Value</th>
                <th className="py-1.5 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {figures.map((f) => {
                const grounded = f.source?.provider && f.source?.ref;
                return (
                  <tr key={f.key} className="border-b border-line hover:bg-hover-paper">
                    <td className="py-2 pr-2 font-medium text-ink">{f.label}</td>
                    <td className="py-2 pr-2 text-ink">
                      {grounded ? (
                        <>
                          {f.value}
                          {f.delta && <span className="ml-1.5 text-xs text-muted">{f.delta}</span>}
                        </>
                      ) : (
                        <span className="text-muted">— withheld (no source)</span>
                      )}
                    </td>
                    <td className="py-2">
                      {grounded ? (
                        <span className="text-xs text-muted">
                          {f.source!.provider} · {f.source!.ref}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-needs bg-needs-tint px-2 py-0.5 text-[0.6875rem] font-medium text-ink">
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
            <p className="mt-2 text-xs text-ink">
              {ungrounded.length} figure{ungrounded.length === 1 ? "" : "s"} missing {ungrounded.length === 1 ? "a" : ""} source —{" "}
              {ungrounded.length === 1 ? "it is" : "they are"} withheld from the PDF until sourced.
            </p>
          )}

          {actionable && phase.kind === "ready" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void postDecision("approve", {}, "Approving and rendering")}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[0.8125rem] font-semibold aos-press disabled:opacity-50 bg-done text-white"
              >
                <Check className="h-3.5 w-3.5" /> Approve &amp; render
              </button>
              <button
                type="button"
                onClick={() => setShowDeny((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[0.8125rem] font-semibold aos-press disabled:opacity-50 bg-paper text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint"
              >
                <X className="h-3.5 w-3.5" /> Deny
              </button>
              <button
                type="button"
                onClick={() => setPhase({ kind: "editing" })}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[0.8125rem] font-semibold aos-press disabled:opacity-50 bg-paper text-ink shadow-outline hover:bg-hover-paper"
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
                className="flex-1 rounded-md border-[1.5px] border-control bg-paper px-2.5 py-1.5 text-[0.8125rem]"
              />
              <button
                type="button"
                onClick={() => void postDecision("deny", { note: denyNote }, "Denying")}
                className="rounded-full bg-paper px-3 py-1.5 text-[0.8125rem] font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint"
              >
                Confirm deny
              </button>
            </div>
          )}

          {actionable && phase.kind === "editing" && (
            <div className="mt-3 rounded-md border border-line bg-canvas p-3">
              <label className="block text-xs font-medium text-muted">Reporting period</label>
              <input
                value={editPeriod}
                onChange={(e) => setEditPeriod(e.target.value)}
                className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2.5 py-1.5 text-[0.8125rem]"
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void postDecision("edit", { period: editPeriod }, "Saving edit")}
                  className="rounded-full bg-ink px-3 py-1.5 text-[0.8125rem] font-semibold text-white aos-press hover:bg-ink-hover"
                >
                  Save — requeue for approval
                </button>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: "ready" })}
                  className="rounded-full bg-paper px-3 py-1.5 text-[0.8125rem] font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper"
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
