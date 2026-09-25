// Marketr — Phase 8: shared UI atoms for the substrate section.
// Exact patterns copied from the Creative Studio reference
// (app/dashboard/studio/StudioApp.tsx + page.tsx). Light mode, Lucide icons,
// no emoji. Styling only — no data or API changes.

import type { ReactNode } from "react";

export const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none";

export const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white transition-[transform,background-color] duration-150 ease-out hover:bg-violet-700 active:scale-[0.97] disabled:opacity-40";

export const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 transition-[transform,background-color] duration-150 ease-out hover:bg-stone-50 active:scale-[0.97] disabled:opacity-40";

export const tableShell = "overflow-hidden rounded-lg border border-stone-200 bg-white";

export const theadCls =
  "border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500";

export const thCls = "px-3 py-2 text-left font-medium";

export const rowCls = "border-b border-stone-100 last:border-0 hover:bg-violet-50/40";

export const infoNoteCls =
  "rounded-lg border border-stone-200 bg-stone-50 p-4 text-[12.5px] text-stone-600";

export const labelCls = "text-[13px] font-medium text-stone-700";

type ChipTone = "slate" | "violet" | "green" | "amber" | "red" | "blue";

export function Chip({ children, tone = "slate" }: { children: ReactNode; tone?: ChipTone }) {
  const tones: Record<ChipTone, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function PageTitle({ title, subtitle }: { title: string; subtitle: ReactNode }) {
  return (
    <div>
      <h1 className="text-xl font-bold tracking-tight text-stone-900">{title}</h1>
      <p className="mt-0.5 text-[13px] text-stone-500">{subtitle}</p>
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
    <section className="rounded-lg border border-stone-200 bg-white p-4">
      <h2 className="text-[14px] font-semibold text-stone-900">{title}</h2>
      {description ? <p className="mt-0.5 text-[12.5px] text-stone-500">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}
