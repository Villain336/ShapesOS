// ShapesOS — Phase 18.2 (WS=comms): the small shared pieces of the
// communication apps (Mail, Calendar, Contacts, Messages, Meet, Reminders),
// built from the Agentic OS tokens (docs/design/DESIGN.md): white cards on
// canvas, pills for pressables, neutral chips (status colours are for agent
// states only), Lucide icons, sentence case.

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export const inputCls =
  "h-control w-full min-w-0 rounded-md border-[1.5px] border-control bg-paper px-3.5 text-md text-ink placeholder:text-subtle transition-[border-color,box-shadow] duration-150 focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)] focus:outline-none";
export const inputSmCls =
  "h-control-sm w-full min-w-0 rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle transition-[border-color,box-shadow] duration-150 focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)] focus:outline-none";
export const textareaCls =
  "w-full min-w-0 rounded-md border-[1.5px] border-control bg-paper px-3.5 py-2.5 text-md text-ink placeholder:text-subtle transition-[border-color,box-shadow] duration-150 focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)] focus:outline-none";
export const labelCls = "text-sm font-semibold text-ink";
/** Icon-only pill button (always give it an aria-label). */
export const iconBtnCls =
  "aos-press inline-flex size-9 shrink-0 items-center justify-center rounded-full text-ink hover:bg-hover disabled:pointer-events-none disabled:text-disabled-fg";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="aos-heading text-ink">{title}</h1>
        {subtitle ? <p className="mt-1 max-w-[70ch] text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ children, className, as: As = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" | "aside"; "aria-label"?: string; "aria-labelledby"?: string }) {
  return (
    <As className={cn("min-w-0 rounded-lg bg-paper shadow-hairline", className)} {...rest}>
      {children}
    </As>
  );
}

export function EmptyState({ icon: Icon, title, body, action, className }: { icon?: LucideIcon; title: string; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
      {Icon ? (
        <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-canvas text-ink" aria-hidden>
          <Icon className="size-5" />
        </span>
      ) : null}
      <p className="text-md font-semibold text-ink">{title}</p>
      {body ? <p className="max-w-[48ch] text-sm text-muted">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** An error line: red square + text (DESIGN.md "Inputs" error pattern). */
export function ErrorLine({ message, className }: { message: string | null | undefined; className?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className={cn("flex items-center gap-2 text-sm font-semibold text-failed-text", className)}>
      <span aria-hidden className="size-2 shrink-0 bg-failed" />
      {message}
    </p>
  );
}

/** A neutral pill (a category, never a status colour). */
export function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-paper px-2.5 text-xs font-semibold whitespace-nowrap text-muted shadow-control", className)}>
      {children}
    </span>
  );
}

/** "Mock" label on rows that came from a connector's labelled mock path (never in production). */
export function MockChip({ label = "Mock", title }: { label?: string; title?: string }) {
  return (
    <span title={title} className="inline-flex h-6 shrink-0 items-center rounded-full bg-canvas px-2.5 text-xs font-semibold whitespace-nowrap text-ink shadow-[inset_0_0_0_1px_var(--aos-line-strong)]">
      {label}
    </span>
  );
}

/** Info note (neutral): a sentence with an optional action. */
export function Note({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3 rounded-lg bg-paper px-4 py-3 text-sm text-muted shadow-hairline", className)}>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

/** Two-letter initials for a person tile (black tile, white letters — like agents, never a colour). */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").replace(/[<>"]/g, " ").trim().split(/[\s@._-]+/).filter(Boolean);
  const out = parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
  return out || "?";
}

export function PersonTile({ name, size = 32, className }: { name: string | null | undefined; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) }}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-sm bg-ink font-semibold text-paper", className)}
    >
      {initials(name)}
    </span>
  );
}
