// ShapesOS — Phase 10 (store): storefront class atoms (Agentic OS tokens
// only — docs/design/DESIGN.md). Plain module (no "use client") so server
// and client components can both use the strings. Stock and order states
// are NEUTRAL chips: the four status colours are reserved for agent states.

export const shopBtnPrimary =
  "inline-flex h-control cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full bg-ink px-[22px] text-[0.9375rem] font-semibold text-paper aos-press hover:bg-ink-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:bg-disabled disabled:text-disabled-fg";

export const shopBtnSecondary =
  "inline-flex h-control cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full bg-paper px-[22px] text-[0.9375rem] font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";

export const shopBtnQuiet =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[0.8125rem] font-semibold text-muted hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";

export const shopInput =
  "h-control rounded-md border-[1.5px] border-control bg-paper px-3 text-[0.9375rem] text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] disabled:opacity-50";

export const shopSelect =
  "h-control cursor-pointer rounded-md border-[1.5px] border-control bg-paper px-3 text-[0.9375rem] text-ink focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";

export const shopCard = "rounded-lg bg-paper shadow-hairline";

export const shopChip = "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-canvas px-2.5 py-0.5 text-[0.8125rem] font-semibold text-ink";

/** An error line: small red square + failed-text (DESIGN.md "Inputs → Error"). */
export const shopErrorText = "flex items-start gap-2 text-[0.8125rem] font-medium text-failed-text";
export const shopErrorMark = "mt-[5px] inline-block h-2 w-2 shrink-0 bg-failed";

export function stockLabel(available: number | null): string {
  if (available === null) return "Available";
  if (available <= 0) return "Out of stock";
  if (available <= 5) return `Only ${available} left`;
  return "In stock";
}
