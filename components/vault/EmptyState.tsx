"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* Vault EmptyState — icon tile + title + description + action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}>
      {icon ? (
        <div className="flex size-10 items-center justify-center rounded-control bg-field text-ink-2 shadow-hairline">
          {icon}
        </div>
      ) : null}
      <div className="mt-3 text-[0.875rem] font-medium text-ink">{title}</div>
      {description ? (
        <p className="mt-1 max-w-70 text-[0.78125rem] leading-relaxed text-ink-2">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
