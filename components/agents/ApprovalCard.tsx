// Marketr — Phase 16 slice 3: ApprovalCard, the FIRST registered generative
// component. Renders a pending AutopilotItem in-flow (agent emits only
// { itemId, projectId }; the card loads live item data from the gate).
//
// Gate law: Approve/Deny/Edit execute through the Phase 14 gate's own
// service functions via the existing API routes — the card never reimplements
// approval logic, and every action writes an audit entry (the gate's service
// functions do that themselves).
//
// Risk-tier badge is a PRESENTATIONAL heuristic (kind → tier), not gate
// semantics: decay_refresh = low, keyword_brief = medium,
// programmatic_page = high (publishes a new page to the web).
//
// House pattern: Agentic OS (docs/design/DESIGN.md) — tokens only, Approve is a
// done-green pill, Deny a failed-ring pill; Lucide icons only.

"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, Pencil, ShieldAlert, X } from "lucide-react";

export interface ApprovalCardProps {
  /** AutopilotItem id (the agent emits this; never agent-invented content). */
  itemId: string;
  /** Project the item belongs to. */
  projectId: string;
  /** Called after a decision lands (approve/deny/edit). */
  onResolved?: (decision: "approved" | "denied" | "edited", itemId: string) => void;
}

interface CardItem {
  id: string;
  kind: "decay_refresh" | "programmatic_page" | "keyword_brief";
  title: string;
  draftMarkdown: string | null;
  status: string;
  reviewNote: string | null;
  createdAt: string;
  rule: { id: string; name: string };
}

type RiskTier = "low" | "medium" | "high";

const RISK_BY_KIND: Record<CardItem["kind"], { tier: RiskTier; label: string }> = {
  decay_refresh: { tier: "low", label: "Low risk" },
  keyword_brief: { tier: "medium", label: "Medium risk" },
  programmatic_page: { tier: "high", label: "High risk" },
};

const KIND_LABEL: Record<CardItem["kind"], string> = {
  decay_refresh: "Content refresh",
  programmatic_page: "New page",
  keyword_brief: "Keyword brief",
};

const TIER_BADGE: Record<RiskTier, string> = {
  // Risk is not an agent state: neutral chips, weight rises with risk.
  low: "bg-canvas text-muted",
  medium: "bg-canvas text-ink",
  high: "bg-ink text-paper",
};

type CardPhase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready" }
  | { kind: "editing" }
  | { kind: "working"; label: string }
  | { kind: "done"; decision: "approved" | "denied" | "edited"; message: string };

export function ApprovalCard({ itemId, projectId, onResolved }: ApprovalCardProps) {
  const [item, setItem] = useState<CardItem | null>(null);
  const [phase, setPhase] = useState<CardPhase>({ kind: "loading" });
  const [editTitle, setEditTitle] = useState("");
  const [editDraft, setEditDraft] = useState("");

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const res = await fetch(
        `/api/autopilot/items/${encodeURIComponent(itemId)}?projectId=${encodeURIComponent(projectId)}`,
      );
      const body = (await res.json()) as { item?: CardItem; error?: string };
      if (!res.ok || !body.item) throw new Error(body.error ?? "Failed to load approval item");
      setItem(body.item);
      setEditTitle(body.item.title);
      setEditDraft(body.item.draftMarkdown ?? "");
      setPhase({ kind: "ready" });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Failed to load approval item" });
    }
  }, [itemId, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const postDecision = useCallback(
    async (path: "approve" | "reject" | "edit", body: Record<string, unknown>, label: string) => {
      setPhase({ kind: "working", label });
      try {
        const res = await fetch(`/api/autopilot/items/${encodeURIComponent(itemId)}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, ...body }),
        });
        const payload = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !payload.ok) throw new Error(payload.error ?? `${label} failed`);
        const decision = path === "approve" ? "approved" : path === "reject" ? "denied" : "edited";
        setPhase({ kind: "done", decision, message: decision === "edited" ? "Saved — still pending approval." : `Item ${decision}.` });
        onResolved?.(decision, itemId);
      } catch (err) {
        setPhase({ kind: "error", message: err instanceof Error ? err.message : `${label} failed` });
      }
    },
    [itemId, projectId, onResolved],
  );

  const approve = () => postDecision("approve", {}, "Approving");
  const deny = () => postDecision("reject", {}, "Denying");
  const saveEdit = () =>
    postDecision("edit", { title: editTitle, draftMarkdown: editDraft }, "Saving edit");

  const risk = item ? RISK_BY_KIND[item.kind] : null;
  const summary = item?.draftMarkdown
    ? item.draftMarkdown.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ")
    : null;

  return (
    <div
      data-testid="approval-card"
      data-item-id={itemId}
      className="rounded-lg bg-paper p-4 text-left shadow-hairline"
    >
      <div className="flex items-center gap-2">
        <span className="aos-shape aos-shape--needs aos-shape--edged" role="img" aria-label="Needs you" />
        <span className="text-[13px] font-semibold text-ink">Approval needed</span>
        {risk && (
          <span
            className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold ${TIER_BADGE[risk.tier]}`}
          >
            {risk.tier === "high" ? (
              <ShieldAlert className="h-3 w-3" aria-hidden />
            ) : (
              <AlertTriangle className="h-3 w-3" aria-hidden />
            )}
            {risk.label}
          </span>
        )}
      </div>

      {phase.kind === "loading" && (
        <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading approval item…
        </div>
      )}

      {phase.kind === "error" && (
        <div className="py-4">
          <p role="alert" className="flex items-start gap-2 text-[13px] text-failed-text">
            <span className="aos-shape aos-shape--failed mt-1 shrink-0" aria-hidden="true" />
            {phase.message}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 inline-flex h-8 items-center rounded-full bg-paper px-3 text-[13px] font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper"
          >
            Retry
          </button>
        </div>
      )}

      {phase.kind === "working" && (
        <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {phase.label}…
        </div>
      )}

      {phase.kind === "done" && (
        <p className="py-4 text-[13px] font-medium text-ink">{phase.message}</p>
      )}

      {item && (phase.kind === "ready" || phase.kind === "editing") && (
        <div className="mt-2">
          <p className="text-xs font-semibold text-muted">
            {KIND_LABEL[item.kind]} · {item.rule.name}
          </p>
          {phase.kind === "editing" ? (
            <div className="mt-2 space-y-2">
              <label className="block">
                <span className="text-[12px] font-medium text-muted">Title</span>
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1.5 text-[13px] text-ink focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-muted">Draft</span>
                <textarea
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  rows={5}
                  className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1.5 text-[13px] text-ink focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]"
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveEdit}
                  className="inline-flex h-8 items-center rounded-full bg-ink px-3 text-[13px] font-semibold text-paper aos-press hover:bg-night-hover"
                >
                  Save edit
                </button>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: "ready" })}
                  className="inline-flex h-8 items-center rounded-full bg-paper px-3 text-[13px] font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper"
                >
                  Cancel
                </button>
              </div>
              <p className="text-[12px] text-muted">
                Edit keeps the item pending — it still needs approval before it can publish.
              </p>
            </div>
          ) : (
            <>
              <h4 className="mt-1 text-[14px] font-semibold text-ink">{item.title}</h4>
              {summary && <p className="mt-1 line-clamp-3 text-[13px] text-muted">{summary}</p>}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={approve}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-done px-3 text-[13px] font-semibold text-paper aos-press"
                >
                  <Check className="h-3.5 w-3.5" aria-hidden /> Approve
                </button>
                <button
                  type="button"
                  onClick={deny}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-paper px-3 text-[13px] font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint"
                >
                  <X className="h-3.5 w-3.5" aria-hidden /> Deny
                </button>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: "editing" })}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-paper px-3 text-[13px] font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
