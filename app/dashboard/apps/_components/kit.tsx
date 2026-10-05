// ShapesOS — Phase 9 (apps): small shared UI bits for the mini-app pages.
// Agentic OS tokens only (DESIGN.md): inputs are radius-md with a 1.5px
// control border; pills for pressables; neutral pills for non-agent states
// (draft / version) — the four status colors stay reserved for agent states.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const inputCls =
  "h-control w-full min-w-0 rounded-md border-[1.5px] border-control bg-paper px-3.5 text-base text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)] disabled:bg-canvas disabled:text-muted aria-[invalid=true]:border-failed";

export const denseInputCls =
  "h-control-sm w-full min-w-0 rounded-md border-[1.5px] border-control bg-paper px-3 text-md text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)] disabled:bg-canvas disabled:text-muted";

export const textareaCls =
  "w-full min-w-0 rounded-md border-[1.5px] border-control bg-paper px-3.5 py-2.5 text-base text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]";

/** A neutral pill for things that aren't agent states (Draft, Version 3, Admins). */
export function NeutralPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center rounded-full bg-paper px-2.5 text-xs font-semibold text-muted shadow-control", className)}>
      {children}
    </span>
  );
}

/** Card surface (radius-lg, hairline). */
export function Panel({ children, className, as: Tag = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "aside" }) {
  return <Tag className={cn("rounded-lg bg-paper shadow-hairline", className)}>{children}</Tag>;
}

/** Error text led by a small red square (the kit's field-error pattern). */
export function ErrorLine({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-2 text-sm font-semibold text-failed-text">
      <span aria-hidden className="mt-1.5 size-2 shrink-0 bg-failed" />
      <span>{children}</span>
    </p>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg bg-paper px-6 py-14 text-center shadow-hairline">
      <span className="text-subtle">{icon}</span>
      <h2 className="aos-subheading">{title}</h2>
      {children ? <div className="max-w-[48ch] text-md text-muted">{children}</div> : null}
    </div>
  );
}
