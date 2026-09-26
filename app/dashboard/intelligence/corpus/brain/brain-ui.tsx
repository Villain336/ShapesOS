// Marketr — Knowledge Brain: shared UI atoms.
// House style per app/dashboard/studio/StudioApp.tsx (diffed class-by-class).
// Used by BrainClient, NodePanel, BrainDialogs, and both 2D/3D views.

import type { BrainPillar } from "@/lib/intelligence/corpus/graph";

export function Chip({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue" | "pink";
}) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-sky-50 text-sky-700 border-sky-200",
    pink: "bg-pink-50 text-pink-700 border-pink-200",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none";
export const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40";
export const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-40";

export const PILLAR_COLORS: Record<BrainPillar, string> = {
  marketing: "#7c3aed",
  growth: "#0284c7",
  design: "#db2777",
};
export const PILLAR_TONE: Record<BrainPillar, "violet" | "blue" | "pink"> = {
  marketing: "violet",
  growth: "blue",
  design: "pink",
};
export const PILLAR_LABEL: Record<BrainPillar, string> = {
  marketing: "Marketing",
  growth: "Growth",
  design: "Design",
};
