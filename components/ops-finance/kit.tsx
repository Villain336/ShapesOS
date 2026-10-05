// ShapesOS — Phase 10 (finance): shared UI bits for the finance pages
// (/dashboard/ops/{accounting,quotes,purchasing,expenses}). Agentic OS tokens
// only (docs/design/DESIGN.md): pills for pressables, radius-md inputs,
// white surfaces on canvas, Lucide icons. Document states (draft, sent,
// paid …) are NEUTRAL pills — the four status colours stay reserved for
// agent states; the one exception is an approval that needs you (the
// existing OpsApprovalCard).

import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export const inputCls =
  "h-control w-full min-w-0 rounded-md border-[1.5px] border-control bg-paper px-3.5 text-base text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)] disabled:bg-canvas disabled:text-muted";

export const denseInputCls =
  "h-control-sm w-full min-w-0 rounded-md border-[1.5px] border-control bg-paper px-3 text-md text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]";

export const labelCls = "mb-1 block text-xs font-semibold text-muted";

export function money(cents: number | null | undefined, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format((cents ?? 0) / 100);
}

/** "12.50" → 1250 (whole cents, never floats in storage). NaN on garbage. */
export function parseMoneyInput(v: string): number {
  const s = v.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function fmtDay(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function FinanceHeader({ title, description, actions }: { title: string; description: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="aos-heading">{title}</h1>
        <p className="mt-1 max-w-[72ch] text-md text-muted">{description}</p>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** Section navigation: pills (Lucide icon + label); the current one is black. */
export function SectionNav({ items, current }: { items: Array<{ href: string; label: string; icon: ReactNode }>; current: string }) {
  return (
    <nav aria-label="Sections" className="flex flex-wrap gap-2">
      {items.map((it) => {
        const active = it.href === current;
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "aos-press inline-flex h-chip items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold whitespace-nowrap",
              active ? "bg-ink text-paper" : "bg-paper text-ink shadow-control hover:shadow-outline",
            )}
          >
            {it.icon}
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center rounded-full bg-paper px-2.5 text-xs font-semibold whitespace-nowrap text-muted shadow-control", className)}>
      {children}
    </span>
  );
}

export function Panel({ title, actions, children, className }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg bg-paper shadow-hairline", className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          {title ? <h2 className="aos-subheading">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Dense table shell (house pattern): header row + hairline rows. */
export function DataTable({ head, children, minWidth = 720 }: { head: Array<{ label: string; align?: "left" | "right" }>; children: ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-line text-xs font-semibold text-muted">
            {head.map((h, i) => (
              <th key={i} scope="col" className={cn("px-4 py-2.5 font-semibold first:pl-5 last:pr-5", h.align === "right" && "text-right")}>
                {h.label ? h.label : <span className="sr-only">Actions</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const rowCls = "border-b border-line text-md text-ink transition-[background-color] duration-150 last:border-0 hover:bg-hover-paper";
export const cellCls = "px-4 py-2.5 align-middle first:pl-5 last:pr-5";
export const numCls = "px-4 py-2.5 text-right align-middle tabular-nums first:pl-5 last:pr-5";

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-sm font-semibold text-failed-text">
      <span aria-hidden className="mt-1.5 size-2 shrink-0 bg-failed" />
      <span>{children}</span>
    </p>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-md bg-canvas px-3 py-2 text-sm text-ink">{children}</p>;
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span className="text-subtle">{icon}</span>
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {children ? <div className="max-w-[52ch] text-md text-muted">{children}</div> : null}
    </div>
  );
}

/** Modal dialog surface (radius-lg, overlay shadow). */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className={cn("flex max-h-[90vh] w-full flex-col gap-4 overflow-y-auto rounded-lg bg-paper p-6 shadow-overlay", wide ? "max-w-[760px]" : "max-w-[520px]")}
      >
        <h2 className="aos-subheading">{title}</h2>
        {children}
      </div>
    </div>
  );
}
