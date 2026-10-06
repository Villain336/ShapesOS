"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card, CardBody } from "@/components/vault/Card";

/* Vault Stat — dashboard number tile. */
export function Stat({
  label,
  value,
  delta,
  deltaTone = "neutral",
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  deltaTone?: "neutral" | "up" | "down";
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardBody className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[0.78125rem] font-medium text-ink-2">{label}</div>
          <div className="mt-1 truncate text-[1.5rem] font-semibold tracking-tight text-ink tabular-nums">
            {value}
          </div>
          {delta ? (
            <div
              className={cn(
                "mt-1 inline-flex items-center rounded-chip px-1.5 py-0.5 text-[0.71875rem] font-medium tabular-nums",
                deltaTone === "up" && "bg-green-tint text-green",
                deltaTone === "down" && "bg-red-tint text-red",
                deltaTone === "neutral" && "bg-field text-ink-2",
              )}
            >
              {delta}
            </div>
          ) : null}
        </div>
        {icon ? <div className="primitive-icon-button shrink-0 text-ink-3">{icon}</div> : null}
      </CardBody>
    </Card>
  );
}
