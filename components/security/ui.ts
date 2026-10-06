// ShapesOS — Agentic OS atoms for the security settings (Phase 4a).
// Tokens only: black primary actions, white pills with an ink ring for
// secondary, Deny/Delete as a white pill with a failed ring.

export const cardCls = "rounded-lg bg-paper p-5 shadow-hairline";
export const labelCls = "mb-1 block text-sm font-semibold text-ink";
export const helpCls = "text-sm text-muted";
export const inputCls =
  "h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-base text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
export const btnPrimary =
  "aos-press inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white hover:bg-ink-hover disabled:bg-disabled disabled:text-disabled-fg";
export const btnSecondary =
  "aos-press inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline hover:bg-hover-paper disabled:bg-disabled disabled:text-disabled-fg";
export const btnQuiet =
  "aos-press inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full px-3 text-sm font-semibold text-ink hover:bg-hover disabled:text-disabled-fg";
export const btnDelete =
  "aos-press inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint disabled:opacity-40";
/** Neutral state chip (not an agent status, so no status colour). */
export const chipCls =
  "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-3 text-[0.8125rem] font-semibold text-ink shadow-control";
export const chipMutedCls =
  "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full bg-canvas px-3 text-[0.8125rem] font-semibold text-muted";
