// ShapesOS — status badge: 28px pill, 10px shape before a 13px/600 label.
//   tone "fill" (default): filled with the status color (Queued = white with
//     a black ring, Paused = line gray).
//   tone "ink": a black pill with the -night mark, for sitting on a status
//     band or a colored surface (agent card header).

import { STATUS_META, type AosStatus } from "@/lib/aos/status";
import { cn } from "@/lib/utils";
import { StatusShape } from "./StatusShape";

export function StatusBadge({
  status,
  label,
  tone = "fill",
  size = "md",
  className,
}: {
  status: AosStatus;
  /** Override the default label ("Succeeded" instead of "Done", …). */
  label?: string;
  tone?: "fill" | "ink";
  size?: "sm" | "md";
  className?: string;
}) {
  const meta = STATUS_META[status];
  const text = label ?? meta.label;
  const sizing = size === "sm" ? "h-6 gap-1.5 px-2.5 text-xs" : "h-badge gap-1.5 px-3 text-sm";
  if (tone === "ink") {
    return (
      <span className={cn("inline-flex shrink-0 items-center rounded-full bg-ink font-semibold whitespace-nowrap text-paper", sizing, className)}>
        <StatusShape status={status} size={size === "sm" ? 8 : 10} tone="night" />
        {text}
      </span>
    );
  }
  const surface =
    status === "queued"
      ? "bg-paper text-ink shadow-outline"
      : status === "paused"
        ? "bg-line text-ink"
        : cn(meta.fill, meta.onFill);
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full font-semibold whitespace-nowrap", sizing, surface, className)}>
      <StatusShape
        status={status}
        size={size === "sm" ? 8 : 10}
        tone="inherit"
        className={status === "running" ? "opacity-70" : undefined}
      />
      {text}
    </span>
  );
}

export default StatusBadge;
