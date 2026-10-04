// ShapesOS — tool chips. Two looks from the kit:
//   variant "toggle": 32px white pill with a hairline ring; pressed = black.
//   variant "tag": the quiet canvas chip on agent cards (not pressable).
// Icons are Lucide, picked by the user-facing tool name.

import type { ComponentType, SVGProps } from "react";
import {
  CalendarDays,
  Database,
  Folder,
  Globe,
  Mail,
  Plug,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

export const TOOL_ICONS: Readonly<Record<string, Icon>> = {
  "web search": Globe,
  web: Globe,
  email: Mail,
  calendar: CalendarDays,
  "code runner": SquareTerminal,
  code: SquareTerminal,
  files: Folder,
  memory: Database,
  "connected apps": Plug,
};

export function toolIcon(name: string): Icon {
  return TOOL_ICONS[name.trim().toLowerCase()] ?? Wrench;
}

export function ToolChip({
  name,
  variant = "toggle",
  pressed,
  onClick,
  className,
}: {
  name: string;
  variant?: "toggle" | "tag";
  /** Toggle chips only: aria-pressed state (black when true). */
  pressed?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const Icon = TOOL_ICONS[name.trim().toLowerCase()] ?? Wrench;
  if (variant === "tag") {
    return (
      <span
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-canvas px-2.5 text-xs font-medium whitespace-nowrap text-ink",
          className,
        )}
      >
        <Icon className="size-3.5" aria-hidden />
        {name}
      </span>
    );
  }
  const cls = cn(
    "inline-flex h-chip shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold whitespace-nowrap transition-[background-color,box-shadow] duration-150",
    pressed ? "bg-ink text-paper" : "bg-paper text-ink shadow-control hover:shadow-outline",
    className,
  );
  if (!onClick && pressed === undefined) {
    return (
      <span className={cls}>
        <Icon className="size-4" aria-hidden />
        {name}
      </span>
    );
  }
  return (
    <button type="button" aria-pressed={!!pressed} onClick={onClick} className={cls}>
      <Icon className="size-4" aria-hidden />
      {name}
    </button>
  );
}

export default ToolChip;
