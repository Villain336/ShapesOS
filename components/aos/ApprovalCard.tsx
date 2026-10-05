"use client";

// ShapesOS — approval card (kit: agent-blocks.png). Yellow header "Needs
// your approval" + the agent's name, the question as the title, what will
// happen, the items it covers, "Show all", an auto-approve opt-in, then
// Deny (white, red ring) / Edit (quiet) / Approve and send (green, check).
// Buttons say exactly what happens; the result keeps the verb.
//
// Three modes, so every queue keeps its own decide rule:
//   "decide"  — inline Deny / Edit / Approve (the queue's API takes a plain POST)
//   "review"  — one yellow Review link to the queue's own screen (codes, edits)
//   "blocked" — the viewer's role can't decide: the reason + Open

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { aosButton } from "./button";
import { StatusShape } from "./StatusShape";

export interface ApprovalItem {
  key: string;
  label: string;
  detail?: string;
}

export type ApprovalCardMode = "decide" | "review" | "blocked";

export function ApprovalCard({
  agent,
  title,
  body,
  meta,
  items = [],
  totalItems,
  showAllHref,
  showAllLabel,
  autoApproveLabel,
  autoApprove,
  onAutoApproveChange,
  mode = "decide",
  approveLabel = "Approve and send",
  denyLabel = "Deny",
  editLabel = "Edit",
  reviewLabel = "Review",
  reviewHref,
  blockedReason,
  openHref,
  openLabel = "Open",
  onApprove,
  onDeny,
  onEdit,
  editHref,
  busy,
  id,
  className,
}: {
  agent: string;
  title: string;
  body?: string | null;
  /** One quiet line under the title (queue, age, risk). */
  meta?: ReactNode;
  items?: ApprovalItem[];
  totalItems?: number;
  showAllHref?: string;
  showAllLabel?: string;
  autoApproveLabel?: string;
  autoApprove?: boolean;
  onAutoApproveChange?: (v: boolean) => void;
  mode?: ApprovalCardMode;
  approveLabel?: string;
  denyLabel?: string;
  editLabel?: string;
  reviewLabel?: string;
  /** mode "review": the queue's own approve/deny screen. */
  reviewHref?: string;
  /** mode "blocked": why this viewer can't decide. */
  blockedReason?: string | null;
  /** mode "blocked": where to read the request. */
  openHref?: string;
  openLabel?: string;
  onApprove?: () => void;
  onDeny?: () => void;
  onEdit?: () => void;
  editHref?: string;
  busy?: "approve" | "deny" | null;
  id?: string;
  className?: string;
}) {
  const checkId = useId();
  const [localAuto, setLocalAuto] = useState(false);
  const auto = autoApprove ?? localAuto;
  const total = totalItems ?? items.length;
  const edit = editHref ? (
    <Link href={editHref} className={aosButton({ variant: "quiet", size: "sm" })}>
      {editLabel}
    </Link>
  ) : onEdit ? (
    <button type="button" onClick={onEdit} className={aosButton({ variant: "quiet", size: "sm" })}>
      {editLabel}
    </button>
  ) : null;
  return (
    <article id={id} className={cn("flex min-w-0 flex-col overflow-hidden rounded-lg bg-paper shadow-hairline", className)}>
      <header className="flex h-11 shrink-0 items-center gap-2.5 bg-needs px-4 text-sm font-semibold text-ink">
        <StatusShape status="needs" size={12} tone="inherit" label="Needs you" />
        <span className="flex-1 truncate">Needs your approval</span>
        <span className="max-w-[45%] truncate">{agent}</span>
      </header>
      <div className="flex flex-1 flex-col px-5 pt-4 pb-5">
        <h3 className="text-xl leading-tight font-bold break-words stretch-heading tracking-heading text-ink">{title}</h3>
        {meta ? <div className="mt-1.5 text-sm text-muted">{meta}</div> : null}
        {body ? <p className="mt-2.5 text-md break-words text-muted">{body}</p> : null}
        {items.length ? (
          <ul className="mt-4 divide-y divide-line rounded-md shadow-hairline">
            {items.map((it) => (
              <li key={it.key} className="flex min-h-10 items-center justify-between gap-3 px-3.5 py-2 text-md">
                <span className="shrink-0 font-semibold text-ink">{it.label}</span>
                {it.detail ? <span className="min-w-0 truncate text-right text-muted">{it.detail}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {total > items.length && showAllHref ? (
          <Link href={showAllHref} className="mt-3 inline-block self-start text-md font-semibold text-ink underline underline-offset-4">
            {showAllLabel ?? `Show all ${total}`}
          </Link>
        ) : null}
        {autoApproveLabel && mode === "decide" ? (
          <div className="mt-3 flex items-center gap-2.5">
            <input
              id={checkId}
              type="checkbox"
              checked={auto}
              onChange={(e) => (onAutoApproveChange ? onAutoApproveChange(e.target.checked) : setLocalAuto(e.target.checked))}
              className="size-[18px] shrink-0 cursor-pointer appearance-none rounded-key bg-paper shadow-[inset_0_0_0_1.5px_var(--aos-control)] checked:bg-ink checked:shadow-none"
            />
            <label htmlFor={checkId} className="text-md text-ink">
              {autoApproveLabel}
            </label>
          </div>
        ) : null}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
          {mode === "decide" ? (
            <>
              <button type="button" onClick={onDeny} disabled={!!busy} className={aosButton({ variant: "deny", size: "sm" })}>
                {busy === "deny" ? "Denying" : denyLabel}
              </button>
              {edit}
              <button
                type="button"
                onClick={onApprove}
                disabled={!!busy}
                className={aosButton({ variant: "approve", size: "md", className: "ml-auto" })}
              >
                <Check className="size-4" aria-hidden />
                {busy === "approve" ? "Approving" : approveLabel}
              </button>
            </>
          ) : mode === "review" ? (
            <>
              {edit}
              {reviewHref ? (
                <Link href={reviewHref} className={aosButton({ variant: "review", size: "md", className: "ml-auto" })}>
                  {reviewLabel}
                  <ArrowUpRight className="size-4" aria-hidden />
                </Link>
              ) : null}
            </>
          ) : (
            <>
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted">
                <Lock className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0">{blockedReason ?? "Your role can view this but not decide it."}</span>
              </span>
              {openHref ? (
                <Link href={openHref} className={aosButton({ variant: "secondary", size: "sm", className: "ml-auto" })}>
                  {openLabel}
                  <ArrowUpRight className="size-4" aria-hidden />
                </Link>
              ) : null}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

export default ApprovalCard;
