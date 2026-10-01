// Marketr — Phase 8: shared UI atoms for the substrate section.
// Agentic OS visual language: black pills, token inputs, neutral chips.
import type { ReactNode } from "react";

export const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

export const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";

export const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";

export const tableShell = "overflow-hidden rounded-lg border border-line bg-paper";

export const theadCls = "border-b border-line text-[11px] font-medium text-muted";

export const thCls = "px-3 py-2 text-left font-medium";

export const rowCls = "border-b border-line last:border-0 hover:bg-hover-paper";

export const infoNoteCls =
  "rounded-lg border border-line bg-paper p-4 text-[12.5px] text-muted";

export const labelCls = "text-[13px] font-medium text-muted";

type ChipTone = "slate" | "violet" | "green" | "amber" | "red" | "blue";

// Substrate states (connector health, queue states) are provider states,
// not agent states — always a neutral chip. The tone prop stays for
// call-site compatibility.
export function Chip({ children, tone = "slate" }: { children: ReactNode; tone?: ChipTone }) {
  void tone;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted shadow-control">
      {children}
    </span>
  );
}

export function PageTitle({ title, subtitle }: { title: string; subtitle: ReactNode }) {
  return (
    <div>
      <h1 className="aos-heading">{title}</h1>
      <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>
    </div>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-paper p-4">
      <h2 className="aos-subheading">{title}</h2>
      {description ? <p className="mt-0.5 text-[12.5px] text-muted">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}
