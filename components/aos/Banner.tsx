"use client";

// ShapesOS — status banner (kit: toasts-and-banners.png). Full status fill
// with the matching text color (black on yellow), the shape first, a title
// and one line, then exactly one action — or a dismiss button.

import Link from "next/link";
import { X } from "lucide-react";
import { STATUS_META, type AosColorStatus } from "@/lib/aos/status";
import { cn } from "@/lib/utils";
import { aosButton } from "./button";
import { StatusShape } from "./StatusShape";

export interface BannerAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export function Banner({
  status,
  title,
  description,
  action,
  onDismiss,
  className,
  statusLabel,
}: {
  status: AosColorStatus;
  title: string;
  description?: string;
  action?: BannerAction | null;
  onDismiss?: () => void;
  className?: string;
  /** Phase 18.1: the state word for screen readers in the person's language. */
  statusLabel?: string;
}) {
  const meta = STATUS_META[status];
  // On yellow the action is black; on blue/green/red it is white.
  const btn = aosButton({ variant: status === "needs" ? "primary" : "on-color", size: "sm", className: "ml-[30px] sm:ml-0" });
  return (
    <div
      role={status === "failed" ? "alert" : "status"}
      className={cn("flex min-h-[72px] flex-wrap items-center gap-x-4 gap-y-3 rounded-md px-5 py-3 sm:flex-nowrap", meta.fill, meta.onFill, className)}
    >
      <StatusShape status={status} size={14} tone="inherit" live={false} label={statusLabel ?? meta.label} className="self-start mt-[3px] sm:self-center sm:mt-0" />
      <div className="min-w-0 flex-1 basis-[calc(100%-2.5rem)] sm:basis-auto">
        <p className="text-base leading-5 font-semibold">{title}</p>
        {description ? <p className="mt-0.5 text-md leading-5">{description}</p> : null}
      </div>
      {action ? (
        action.href ? (
          <Link href={action.href} className={btn}>
            {action.label}
          </Link>
        ) : (
          <button type="button" onClick={action.onClick} className={btn}>
            {action.label}
          </button>
        )
      ) : onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-ink/10"
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export default Banner;
