"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* Vault Card — the single card language for the app:
 * rounded-card + bg-surface + shadow-card (hairline ring + smooth stack).
 * Do NOT hand-roll card divs elsewhere. */
export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-card bg-surface shadow-card", className)}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("primitive-card-bar flex items-center justify-between gap-3 border-b border-line", className)}>
      <div className="min-w-0">
        <h3 className="truncate text-[14px] font-medium text-ink">{title}</h3>
        {description ? (
          <p className="mt-0.5 truncate text-[12.5px] text-ink-2">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("primitive-card-pad", className)}>{children}</div>;
}
