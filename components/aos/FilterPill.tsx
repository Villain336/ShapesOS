// ShapesOS — filter pill (DESIGN.md "Chips and tool toggles"): 32px pill,
// white with shadow-control, black ring on hover; the selected filter is
// solid black with white text. An optional status shape leads it when the
// filter IS an agent state (Running, Needs you, …) and a count trails it.
// Renders a <button aria-pressed> or, with href, a <Link aria-current>.

import Link from "next/link";
import type { ReactNode } from "react";
import type { AosStatus } from "@/lib/aos/status";
import { cn } from "@/lib/utils";
import { StatusShape } from "./StatusShape";

export function FilterPill({
  selected,
  status,
  count,
  href,
  onClick,
  children,
  className,
}: {
  selected: boolean;
  /** Leads with the state's shape (agent-state filters only). */
  status?: AosStatus;
  count?: number;
  href?: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  const cls = cn(
    "aos-press inline-flex h-chip shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold whitespace-nowrap",
    selected ? "bg-ink text-paper" : "bg-paper text-ink shadow-control hover:shadow-outline",
    className,
  );
  const body = (
    <>
      {status ? <StatusShape status={status} size={9} tone={selected ? "night" : "paper"} live={false} /> : null}
      {children}
      {typeof count === "number" ? (
        <span className={cn("tabular-nums", selected ? "text-night-soft" : "text-muted")}>{count}</span>
      ) : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} aria-current={selected ? "page" : undefined} className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} className={cls}>
      {body}
    </button>
  );
}

export default FilterPill;
