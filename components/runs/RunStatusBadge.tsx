// ShapesOS — agent run status badge (shared by the runs index and the run
// viewer). Run statuses are genuine agent states → status color + shape +
// text label. Cancelled has no status color in the system — neutral chip.

import type { AgentRunStatus } from "@/lib/agents/runs/types";

export function RunStatusBadge({ status }: { status: AgentRunStatus }) {
  const base = "inline-flex h-badge items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm font-semibold";
  const shape = (extra: string) => (
    <span className={`aos-shape ${extra}`} style={{ color: "inherit" }} aria-hidden />
  );
  switch (status) {
    case "running":
      return (
        <span className={`${base} bg-running text-white`}>
          {shape("aos-shape--running aos-is-live")} Running
        </span>
      );
    case "succeeded":
      return (
        <span className={`${base} bg-done text-white`}>
          {shape("aos-shape--done")} Succeeded
        </span>
      );
    case "failed":
      return (
        <span className={`${base} bg-failed text-white`}>
          {shape("aos-shape--failed")} Failed
        </span>
      );
    // Phase 16: waiting for the user's OK (a sub-agent's proposal) — needs you.
    case "awaiting_confirmation":
      return (
        <span className={`${base} bg-needs text-ink`}>
          {shape("aos-shape--needs")} Needs you
        </span>
      );
    case "queued":
      return (
        <span className={`${base} bg-paper text-ink shadow-outline`}>
          {shape("aos-shape--queued")} Queued
        </span>
      );
    default:
      return (
        <span className="inline-flex h-badge items-center rounded-full bg-paper px-3 text-sm font-semibold text-muted shadow-control">
          Cancelled
        </span>
      );
  }
}

export default RunStatusBadge;
