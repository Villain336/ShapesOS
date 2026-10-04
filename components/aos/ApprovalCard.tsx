"use client";

// ShapesOS — approval card (kit: agent-blocks.png). Yellow header "Needs
// your approval" + the agent's name, the question as the title, what will
// happen, the items it covers, "Show all", an auto-approve opt-in, then
// Deny (white, red ring) / Edit (quiet) / Approve and send (green, check).
// Buttons say exactly what happens; the result keeps the verb.

import Link from "next/link";
import { useId, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { aosButton } from "./button";
import { StatusShape } from "./StatusShape";

export interface ApprovalItem {
  key: string;
  label: string;
  detail?: string;
}

export function ApprovalCard({
  agent,
  title,
  body,
  items = [],
  totalItems,
  showAllHref,
  showAllLabel,
  autoApproveLabel,
  autoApprove,
  onAutoApproveChange,
  approveLabel = "Approve and send",
  denyLabel = "Deny",
  editLabel = "Edit",
  onApprove,
  onDeny,
  onEdit,
  editHref,
  busy,
  className,
}: {
  agent: string;
  title: string;
  body?: string;
  items?: ApprovalItem[];
  totalItems?: number;
  showAllHref?: string;
  showAllLabel?: string;
  autoApproveLabel?: string;
  autoApprove?: boolean;
  onAutoApproveChange?: (v: boolean) => void;
  approveLabel?: string;
  denyLabel?: string;
  editLabel?: string;
  onApprove?: () => void;
  onDeny?: () => void;
  onEdit?: () => void;
  editHref?: string;
  busy?: "approve" | "deny" | null;
  className?: string;
}) {
  const checkId = useId();
  const [localAuto, setLocalAuto] = useState(false);
  const auto = autoApprove ?? localAuto;
  const total = totalItems ?? items.length;
  return (
    <article className={cn("overflow-hidden rounded-lg bg-paper shadow-hairline", className)}>
      <header className="flex h-11 items-center gap-2.5 bg-needs px-4 text-sm font-semibold text-ink">
        <StatusShape status="needs" size={12} tone="inherit" label="Needs you" />
        <span className="flex-1">Needs your approval</span>
        <span>{agent}</span>
      </header>
      <div className="px-5 pt-4 pb-5">
        <h3 className="text-xl leading-tight font-bold stretch-heading tracking-heading text-ink">{title}</h3>
        {body ? <p className="mt-2.5 text-md text-muted">{body}</p> : null}
        {items.length ? (
          <ul className="mt-4 divide-y divide-line rounded-md shadow-hairline">
            {items.map((it) => (
              <li key={it.key} className="flex h-10 items-center justify-between gap-3 px-3.5 text-md">
                <span className="truncate font-semibold text-ink">{it.label}</span>
                {it.detail ? <span className="truncate text-muted">{it.detail}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {total > items.length && showAllHref ? (
          <Link href={showAllHref} className="mt-3 inline-block text-md font-semibold text-ink underline underline-offset-4">
            {showAllLabel ?? `Show all ${total}`}
          </Link>
        ) : null}
        {autoApproveLabel ? (
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
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onDeny} disabled={!!busy} className={aosButton({ variant: "deny", size: "sm" })}>
            {busy === "deny" ? "Denying" : denyLabel}
          </button>
          {editHref ? (
            <Link href={editHref} className={aosButton({ variant: "quiet", size: "sm" })}>
              {editLabel}
            </Link>
          ) : onEdit ? (
            <button type="button" onClick={onEdit} className={aosButton({ variant: "quiet", size: "sm" })}>
              {editLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onApprove}
            disabled={!!busy}
            className={aosButton({ variant: "approve", size: "md", className: "ml-auto" })}
          >
            <Check className="size-4" aria-hidden />
            {busy === "approve" ? "Approving" : approveLabel}
          </button>
        </div>
      </div>
    </article>
  );
}

export default ApprovalCard;
