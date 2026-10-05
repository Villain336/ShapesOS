// ShapesOS — menu surface + rows (kit: sidebar-and-menus.png agent menu,
// workspace switcher; command-and-inputs.png palette rows). White,
// radius-lg, raised shadow; 44px rows with radius-sm; the active row is solid
// black; destructive rows use failed-text with a failed-tint hover.
// Presentational: interactive menus wrap these in the dropdown primitive.

import type { ComponentType, ReactNode, SVGProps } from "react";
import { cn } from "@/lib/utils";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export function MenuSurface({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div role="menu" aria-label={label} className={cn("rounded-lg bg-paper p-1.5 shadow-raised", className)}>
      {children}
    </div>
  );
}

export function MenuLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-3 pt-2 pb-1 text-xs font-semibold text-muted", className)}>{children}</div>;
}

export function MenuSeparator({ className }: { className?: string }) {
  return <div role="separator" className={cn("mx-2 my-1.5 h-px bg-line", className)} />;
}

export function MenuRow({
  icon: IconCmp,
  leading,
  label,
  hint,
  trailing,
  shortcut,
  active,
  destructive,
  onClick,
  className,
}: {
  icon?: Icon;
  /** Custom leading element (agent tile, workspace tile). */
  leading?: ReactNode;
  label: ReactNode;
  /** Secondary text after the label ("Step 3 of 7 · reading sources"). */
  hint?: ReactNode;
  /** Right side (status, check, "Connected"). */
  trailing?: ReactNode;
  /** Shortcut text in mono ("⌘D"). */
  shortcut?: string;
  active?: boolean;
  destructive?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 rounded-sm px-3 text-left text-base font-medium transition-[background-color] duration-150",
        active
          ? "bg-ink text-paper"
          : destructive
            ? "text-failed-text hover:bg-failed-tint"
            : "text-ink hover:bg-hover-paper",
        className,
      )}
    >
      {leading ?? (IconCmp ? <IconCmp className="size-4 shrink-0" aria-hidden /> : null)}
      <span className="min-w-0 flex-1 truncate">
        {label}
        {hint ? <span className={cn("ml-2 text-sm font-normal", active ? "text-night-soft" : "text-muted")}>{hint}</span> : null}
      </span>
      {trailing}
      {shortcut ? <span className={cn("aos-mono shrink-0 text-xs", active ? "text-night-soft" : "text-muted")}>{shortcut}</span> : null}
    </button>
  );
}
