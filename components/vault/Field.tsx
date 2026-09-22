"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/vault/shadcn/label";

/* Vault Field — label + control + hint/error. Wraps any input. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <Label htmlFor={htmlFor} className="text-[12.5px] font-medium text-ink-2">
          {label}
        </Label>
      ) : null}
      {children}
      {error ? (
        <span className="text-[12px] text-red">{error}</span>
      ) : hint ? (
        <span className="text-[12px] text-ink-3">{hint}</span>
      ) : null}
    </div>
  );
}
