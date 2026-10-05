"use client";

// ShapesOS — toast (kit: toasts-and-banners.png). Black night surface,
// radius-lg, led by the status shape in its -night color, title + one line,
// at most ONE action as a pill under the text, dismiss at the top right.
// Optional progress row ("7 of 12") for live work. The Undo variant is the
// one-line toast: message, underlined Undo, dismiss.
//
// Presentational: the app-wide stack (lib/ui/feedback.ts → FeedbackHost)
// renders every toast through this, and the gallery shows each state.

import Link from "next/link";
import { X, type LucideIcon } from "lucide-react";
import { STATUS_META, type AosColorStatus } from "@/lib/aos/status";
import { progressFraction, ofCaption } from "@/lib/aos/run-steps";
import { cn } from "@/lib/utils";
import { StatusShape } from "./StatusShape";

export interface ToastViewAction {
  label: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}

export function ToastView({
  status = "done",
  icon: Icon,
  title,
  description,
  action,
  progress,
  meta,
  variant = "default",
  onDismiss,
  className,
  ...rest
}: {
  /** The agent state that leads the toast; null = not an agent state (lead with `icon`). */
  status?: AosColorStatus | null;
  /** Neutral lead icon (Lucide) when `status` is null — never a status color. */
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ToastViewAction | null;
  progress?: { done: number; total: number } | null;
  /** A quiet line under the text (when it happened, where it came from). */
  meta?: string;
  /** "undo": one line, the action is an underlined text button. */
  variant?: "default" | "undo";
  onDismiss?: () => void;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "title">) {
  const dismiss = onDismiss ? (
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Dismiss notification"
      className="-mt-1 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-night-soft hover:bg-night-hover hover:text-paper"
    >
      <X className="size-4" aria-hidden />
    </button>
  ) : null;

  if (variant === "undo") {
    return (
      <div
        className={cn("aos-night pointer-events-auto flex min-h-14 w-full items-center gap-3 rounded-lg py-2 pr-3 pl-4 shadow-toast animate-toast-in", className)}
        {...rest}
      >
        <div className="min-w-0 flex-1 truncate text-md font-medium text-paper">{title}</div>
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            className="shrink-0 px-1 text-md font-semibold text-paper underline underline-offset-4 disabled:text-night-soft disabled:no-underline"
          >
            {action.label}
          </button>
        ) : null}
        {dismiss ? <span className="mt-1 mr-1">{dismiss}</span> : null}
      </div>
    );
  }

  const statusMeta = status ? STATUS_META[status] : null;
  return (
    <div
      className={cn("aos-night pointer-events-auto flex w-full items-start gap-3 rounded-lg p-4 shadow-toast animate-toast-in", className)}
      {...rest}
    >
      {status && statusMeta ? (
        <StatusShape status={status} size={12} tone="night" label={statusMeta.label} className="mt-1" />
      ) : Icon ? (
        <Icon className="mt-0.5 size-4 shrink-0 text-night-soft" aria-hidden />
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="text-base leading-5 font-semibold text-paper">{title}</p>
        {description ? <p className="mt-1 text-md leading-5 text-night-soft">{description}</p> : null}
        {meta ? <p className="mt-1 text-xs text-night-muted">{meta}</p> : null}
        {progress ? (
          <div className="mt-2 flex items-center gap-3">
            <div
              className="h-1 flex-1 overflow-hidden rounded-full bg-night-raised"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
              aria-label={`${title}: ${ofCaption(progress.done, progress.total)}`}
            >
              <div className="h-full rounded-full bg-running-night" style={{ width: `${progressFraction(progress.done, progress.total) * 100}%` }} />
            </div>
            <span className="shrink-0 text-sm text-night-soft tabular-nums">{ofCaption(progress.done, progress.total)}</span>
          </div>
        ) : null}
        {action ? (
          <div className="mt-3">
            {action.href ? (
              <Link href={action.href} className="aos-press inline-flex h-8 items-center rounded-full bg-paper px-3.5 text-sm font-semibold text-ink">
                {action.label}
              </Link>
            ) : (
              <button
                type="button"
                onClick={action.onClick}
                disabled={action.disabled}
                className="aos-press inline-flex h-8 items-center rounded-full bg-paper px-3.5 text-sm font-semibold text-ink disabled:bg-night-raised disabled:text-night-soft"
              >
                {action.label}
              </button>
            )}
          </div>
        ) : null}
      </div>
      {dismiss}
    </div>
  );
}

export default ToastView;
