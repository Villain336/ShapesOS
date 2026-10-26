// ShapesOS — the Feed's "Needs you" section (approved flat-feed redesign).
//
// Pending approval requests as flat rows — hairline dividers, not cards —
// sharing the approvals inbox's decision path
// (components/approvals/useApprovalDecide.ts):
//   inline Approve / Deny when the queue's API takes a plain POST and the
//   viewer's role may decide (the queue's route re-checks every rule: role,
//   separation of duties, two-person approvals, expiry);
//   Edit / Review on the queue's own screen otherwise (codes, channels,
//   edits), with the reason when the viewer's role can't decide.
// Deciding removes the row and refreshes the sidebar Needs-you count.

"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { StatusShape, aosButton } from "@/components/aos";
import { useApprovalDecide } from "@/components/approvals/useApprovalDecide";
import { ageLabel, type InboxItem } from "@/lib/approvals/types";
import { approveLabelFor, editLabelFor } from "@/lib/aos/approvals";
import { useI18n } from "@/components/i18n/I18nProvider";

function Row({
  item,
  busy,
  onDecide,
}: {
  item: InboxItem;
  busy: "approve" | "deny" | null;
  onDecide: (item: InboxItem, which: "approve" | "deny") => void;
}) {
  const { t, format } = useI18n();
  const inline = item.canDecide && item.approve;
  return (
    <li className="flex gap-3 border-t border-line py-4 first:border-t-0 first:pt-1">
      <StatusShape status="needs" size={12} className="mt-1" />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-medium text-ink">{item.title}</div>
        {item.detail ? <p className="mt-0.5 line-clamp-2 text-sm text-muted">{item.detail}</p> : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {inline ? (
            <>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => onDecide(item, "approve")}
                className={aosButton({ variant: "approve", size: "sm" })}
              >
                {busy === "approve" ? <Loader2 size={14} className="aos-spin" aria-hidden /> : approveLabelFor(item)}
              </button>
              <Link href={item.href} className={aosButton({ variant: "secondary", size: "sm" })}>
                {editLabelFor(item)}
              </Link>
              {item.deny ? (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => onDecide(item, "deny")}
                  className={aosButton({ variant: "deny", size: "sm" })}
                >
                  {busy === "deny" ? <Loader2 size={14} className="aos-spin" aria-hidden /> : "Deny"}
                </button>
              ) : null}
            </>
          ) : (
            <>
              <Link href={item.href} className={aosButton({ variant: "secondary", size: "sm" })}>
                {t("desk.views.review")}
              </Link>
              {item.blockedReason ? <span className="text-xs text-muted">{item.blockedReason}</span> : null}
            </>
          )}
        </div>
        <div className="mt-1.5 text-xs text-muted">
          {[item.agent, item.typeLabel, t("status.needs")].filter(Boolean).join(" · ")}
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted" title={format.date(item.createdAt, "dateTime")}>
        {ageLabel(item.createdAt)}
      </span>
    </li>
  );
}

export function FeedNeedsYou({ items: initial }: { items: InboxItem[] }) {
  const [items, setItems] = useState(initial);
  const { busy, decide } = useApprovalDecide();

  if (!items.length) return null;
  return (
    <ul>
      {items.map((item) => (
        <Row
          key={item.key}
          item={item}
          busy={busy?.key === item.key ? busy.which : null}
          onDecide={(i, w) =>
            void decide(i, w, (decided) => setItems((prev) => prev.filter((x) => x.key !== decided.key)))
          }
        />
      ))}
    </ul>
  );
}
