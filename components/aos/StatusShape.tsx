// ShapesOS — Agentic OS status shape (circle / triangle / quarter-disc /
// square / ring / bars). Color never appears without its shape; pass `label`
// when the shape stands alone so screen readers hear the state too.

import { SHAPE_PATHS, STATUS_META, type AosStatus } from "@/lib/aos/status";
import { cn } from "@/lib/utils";

export type ShapeTone =
  /** On paper or canvas: the status color (yellow gets a black edge). */
  | "paper"
  /** On black surfaces: the brighter -night marks. */
  | "night"
  /** Inside a filled badge/banner: the surrounding text color. */
  | "inherit";

export interface StatusShapeProps {
  status: AosStatus;
  /** Pixel size (default 10). */
  size?: number;
  tone?: ShapeTone;
  /** Pulse while live (defaults to on for running). */
  live?: boolean;
  /** Accessible name; omit when a visible text label sits next to it. */
  label?: string;
  className?: string;
}

export function StatusShape({ status, size = 10, tone = "paper", live, label, className }: StatusShapeProps) {
  const meta = STATUS_META[status];
  const geo = SHAPE_PATHS[status];
  const color = tone === "inherit" ? "currentColor" : tone === "night" ? meta.markNight : meta.mark;
  const pulse = live ?? meta.live;
  const edged = status === "needs" && tone === "paper";
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      className={cn("shrink-0", pulse && "animate-status-pulse", className)}
      style={{ overflow: "visible", transformOrigin: "center", transformBox: "fill-box" }}
      {...a11y}
    >
      {geo.stroke ? (
        <path
          d={geo.d}
          fill="none"
          stroke={color}
          strokeWidth={geo.stroke}
          strokeLinecap={status === "paused" ? "butt" : undefined}
        />
      ) : (
        <path
          d={geo.d}
          fill={color}
          stroke={edged ? "var(--aos-ink)" : undefined}
          strokeWidth={edged ? 1 : undefined}
          strokeLinejoin={edged ? "round" : undefined}
        />
      )}
    </svg>
  );
}

export default StatusShape;
