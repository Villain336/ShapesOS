// ShapesOS — agent card (kit: agent-blocks.png). A status-colored header
// band with the large cropped status shape and the status badge, then the
// title, a two-line description, tool chips, and a footer with one meta line
// and exactly one action. The band shows the CURRENT state, never identity.

import Link from "next/link";
import type { ReactNode } from "react";
import type { AosStatus } from "@/lib/aos/status";
import { cn } from "@/lib/utils";
import { aosButton } from "./button";
import { CroppedShape, statusSurface } from "./CroppedShape";
import { StatusBadge } from "./StatusBadge";
import { ToolChip } from "./ToolChip";

export interface CardAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export function CardActionButton({ action, status }: { action: CardAction; status: AosStatus }) {
  const cls = aosButton({ variant: status === "needs" ? "review" : "primary", size: "sm" });
  if (action.href) {
    return (
      <Link href={action.href} className={cls}>
        {action.label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.onClick} className={cls}>
      {action.label}
    </button>
  );
}

export function AgentCard({
  status,
  title,
  description,
  tools = [],
  meta,
  action,
  badgeLabel,
  eyebrow,
  toolLabels,
  className,
  children,
}: {
  status: AosStatus;
  title: string;
  description?: string;
  tools?: string[];
  meta?: ReactNode;
  action?: CardAction | null;
  /** Override the badge text ("Step 3 of 7" stays in meta; this is the state word). */
  badgeLabel?: string;
  /** Small line above the title, e.g. the agent that owns the work. */
  eyebrow?: ReactNode;
  /** Phase 18.1: tool chip names in the person's language ({ [English name]: label }). */
  toolLabels?: Readonly<Record<string, string>>;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <article className={cn("flex min-w-0 flex-col overflow-hidden rounded-lg bg-paper shadow-hairline", className)}>
      <div className={cn("relative h-[124px] shrink-0 overflow-hidden", statusSurface(status))}>
        <CroppedShape status={status} />
        <StatusBadge status={status} label={badgeLabel} tone="ink" className="absolute bottom-4 left-5" />
      </div>
      <div className="flex flex-1 flex-col px-5 pt-4 pb-4">
        {eyebrow ? <div className="mb-1 text-xs font-semibold text-muted">{eyebrow}</div> : null}
        <h3 className="line-clamp-2 text-xl leading-tight font-bold stretch-heading tracking-heading text-ink">{title}</h3>
        {description ? <p className="mt-2 line-clamp-2 text-md text-muted">{description}</p> : null}
        {tools.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tools.map((t) => (
              <ToolChip key={t} name={t} label={toolLabels?.[t]} variant="tag" />
            ))}
          </div>
        ) : null}
        {children}
        <div className="mt-auto pt-4">
          <div className="flex min-h-[52px] items-center justify-between gap-3 border-t border-line pt-3.5">
            <span className="min-w-0 truncate text-sm text-muted">{meta}</span>
            {action ? <CardActionButton action={action} status={status} /> : null}
          </div>
        </div>
      </div>
    </article>
  );
}

export default AgentCard;
