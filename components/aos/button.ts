// ShapesOS — Agentic OS pill button classes (usable on <button> and <Link>).
// Primary actions are black; a colored button means the action changes that
// state (DESIGN.md action table): Run/Resume = running, Review = needs (black
// text), Approve = done, Stop = failed, Deny/Delete = white + failed ring.

import { cn } from "@/lib/utils";

export type AosButtonVariant =
  | "primary"
  | "secondary"
  | "quiet"
  | "run"
  | "review"
  | "approve"
  | "stop"
  | "deny"
  /** On black surfaces (toasts, live activity): white fill. */
  | "night"
  /** On black surfaces: outlined. */
  | "night-outline"
  /** On a colored banner: white fill, black text. */
  | "on-color";

export type AosButtonSize = "xs" | "sm" | "md" | "lg";

const VARIANTS: Record<AosButtonVariant, string> = {
  primary: "bg-ink text-paper hover:bg-ink-hover",
  secondary: "bg-paper text-ink shadow-outline hover:bg-hover-paper",
  quiet: "bg-transparent text-ink hover:bg-hover",
  run: "bg-running text-paper hover:bg-running-pressed",
  review: "bg-needs text-ink",
  approve: "bg-done text-paper",
  stop: "bg-failed text-paper",
  deny: "bg-paper text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint",
  night: "bg-paper text-ink",
  "night-outline": "bg-transparent text-paper shadow-[inset_0_0_0_1px_var(--aos-night-border)] hover:bg-night-hover",
  "on-color": "bg-paper text-ink",
};

const SIZES: Record<AosButtonSize, string> = {
  xs: "h-8 px-3.5 text-sm",
  sm: "h-control-sm px-4 text-sm",
  md: "h-control px-[22px] text-base",
  lg: "h-control-lg px-[26px] text-base",
};

export function aosButton({
  variant = "primary",
  size = "md",
  className,
}: { variant?: AosButtonVariant; size?: AosButtonSize; className?: string } = {}): string {
  return cn(
    "aos-press inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap disabled:pointer-events-none disabled:bg-disabled disabled:text-disabled-fg disabled:shadow-none",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}
