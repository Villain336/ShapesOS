// ShapesOS — the large status shape that bleeds off the edge of an agent
// card's header band or a foundation tile (kit: agent-blocks.png,
// foundations.png). White on blue/green/red, black on yellow; Queued and
// Paused draw in ink on a neutral band. Decorative: the band always carries a
// text status badge, so this is aria-hidden.

import type { AosStatus } from "@/lib/aos/status";
import { cn } from "@/lib/utils";

type Geometry = { w: number; h: number; anchor: "top-right" | "bottom-right"; el: (fill: string) => React.ReactNode };

// Pixel geometry in a box anchored to the container's right edge; the
// container clips whatever bleeds past it. Measured off the kit renders.
const BAND: Record<AosStatus, Geometry> = {
  running: { w: 200, h: 124, anchor: "top-right", el: (f) => <circle cx={155} cy={58} r={92} fill={f} /> },
  needs: { w: 200, h: 124, anchor: "top-right", el: (f) => <path d="M138 0 206 126H70z" fill={f} /> },
  done: { w: 200, h: 124, anchor: "top-right", el: (f) => <path d="M56 132V-14a146 146 0 0 1 146 146z" fill={f} /> },
  failed: { w: 200, h: 124, anchor: "top-right", el: (f) => <path d="M106 -60 251 -21 212 124 67 85z" fill={f} /> },
  queued: {
    w: 200,
    h: 124,
    anchor: "top-right",
    el: (f) => <circle cx={150} cy={62} r={70} fill="none" stroke={f} strokeWidth={14} />,
  },
  paused: {
    w: 200,
    h: 124,
    anchor: "top-right",
    el: (f) => (
      <>
        <rect x={104} y={22} width={30} height={120} fill={f} />
        <rect x={160} y={22} width={30} height={120} fill={f} />
      </>
    ),
  },
};

const TILE: Record<AosStatus, Geometry> = {
  running: { w: 160, h: 150, anchor: "bottom-right", el: (f) => <circle cx={110} cy={97} r={92} fill={f} /> },
  needs: { w: 160, h: 150, anchor: "bottom-right", el: (f) => <path d="M97 0 176 150H18z" fill={f} /> },
  done: { w: 160, h: 150, anchor: "bottom-right", el: (f) => <path d="M15 152V4a148 148 0 0 1 148 148z" fill={f} /> },
  failed: { w: 160, h: 150, anchor: "bottom-right", el: (f) => <path d="M69 29 214 68 175 213 30 174z" fill={f} /> },
  queued: { w: 160, h: 150, anchor: "bottom-right", el: (f) => <circle cx={110} cy={97} r={70} fill="none" stroke={f} strokeWidth={14} /> },
  paused: {
    w: 160,
    h: 150,
    anchor: "bottom-right",
    el: (f) => (
      <>
        <rect x={60} y={30} width={30} height={130} fill={f} />
        <rect x={116} y={30} width={30} height={130} fill={f} />
      </>
    ),
  },
};

export function shapeFillFor(status: AosStatus): string {
  return status === "needs" || status === "queued" || status === "paused" ? "var(--aos-ink)" : "var(--aos-paper)";
}

export function CroppedShape({
  status,
  variant = "band",
  className,
}: {
  status: AosStatus;
  variant?: "band" | "tile";
  className?: string;
}) {
  const g = (variant === "band" ? BAND : TILE)[status];
  return (
    <svg
      aria-hidden
      width={g.w}
      height={g.h}
      viewBox={`0 0 ${g.w} ${g.h}`}
      className={cn("pointer-events-none absolute right-0", g.anchor === "top-right" ? "top-0" : "bottom-0", className)}
    >
      {g.el(shapeFillFor(status))}
    </svg>
  );
}

/** Band / tile surface for a state. */
export function statusSurface(status: AosStatus): string {
  switch (status) {
    case "running":
      return "bg-running text-paper";
    case "needs":
      return "bg-needs text-ink";
    case "done":
      return "bg-done text-paper";
    case "failed":
      return "bg-failed text-paper";
    case "queued":
      return "bg-canvas text-ink";
    default:
      return "bg-line text-ink";
  }
}

export default CroppedShape;
