// ShapesOS — Agentic OS class atoms for the workspace/account surfaces
// (docs/design/DESIGN.md): pills for pressables, black primary actions,
// tokens only. Shared by the onboarding wizard, Settings → General and
// Settings → Clients.

export const btnPrimary =
  "inline-flex h-control items-center justify-center gap-2 rounded-full bg-ink px-[22px] text-base font-semibold text-paper aos-press disabled:pointer-events-none disabled:bg-disabled disabled:text-disabled-fg";

export const btnSecondary =
  "inline-flex h-control items-center justify-center gap-2 rounded-full bg-paper px-[22px] text-base font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:pointer-events-none disabled:bg-disabled disabled:text-disabled-fg disabled:shadow-none";

export const btnQuiet =
  "inline-flex h-control items-center justify-center gap-2 rounded-full px-4 text-base font-semibold text-ink hover:bg-hover disabled:pointer-events-none disabled:text-disabled-fg";

/** Deny / Delete: white, failed-text label, 1.5px failed ring. */
export const btnDanger =
  "inline-flex h-control items-center justify-center gap-2 rounded-full bg-paper px-[22px] text-base font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:pointer-events-none disabled:bg-disabled disabled:text-disabled-fg disabled:shadow-none";

export const btnSmallSecondary =
  "inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:pointer-events-none disabled:text-disabled-fg";

export const btnSmallDanger =
  "inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:pointer-events-none disabled:text-disabled-fg";

export const inputCls =
  "h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-base text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] aria-[invalid=true]:border-failed";

export const textareaCls =
  "w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2.5 text-base text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";

export const labelCls = "block text-sm font-semibold text-ink";
export const helperCls = "mt-1 text-sm text-muted";

export const cardCls = "rounded-lg bg-paper p-5 shadow-hairline";

/** Toggle chip; pass aria-pressed. */
export function chipCls(pressed: boolean): string {
  return `inline-flex h-chip items-center gap-1.5 rounded-full px-3 text-sm font-semibold transition-colors ${
    pressed ? "bg-ink text-paper" : "bg-paper text-ink shadow-control hover:shadow-outline"
  }`;
}
