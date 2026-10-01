// Marketr — Phase 11 "Canvas" editor shared UI classes.
// Agentic OS design system (docs/design/DESIGN.md): black primaries,
// pills for pressables, tokens only, no legacy violet.

export const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-2.5 text-[13px] text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

export const btnPrimary =
  "flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg disabled:opacity-100";

export const btnGhost =
  "flex h-control-sm items-center gap-1.5 rounded-full border border-line bg-paper px-4 text-sm font-medium text-ink shadow-outline hover:bg-hover-paper aos-press disabled:opacity-40";

export const iconBtn =
  "flex h-7 w-7 items-center justify-center rounded-full border border-line bg-paper text-muted hover:bg-hover-paper hover:text-ink disabled:opacity-40";

export const iconBtnActive =
  "flex h-7 w-7 items-center justify-center rounded-full border border-line bg-ink text-paper disabled:opacity-40";

export const panelTitle =
  "px-3 pb-2 pt-3 text-xs font-semibold text-muted";

export const panelSectionLabel =
  "mb-1.5 text-xs font-semibold text-muted";
