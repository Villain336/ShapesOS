"use client";

// ShapesOS — Phase 17 (latency): the status line under the transcript while
// a turn is in flight: "Sending" the instant a message leaves the composer,
// "Working" on the first frame, "Thinking" while the model reasons, "Running
// <tool>" during a tool call. Agentic OS: the running state is the blue
// circle (pulsing while live) next to muted text — no spinner, no glow, and
// no colour once the turn is over (the line disappears).

import { StatusShape } from "@/components/aos/StatusShape";

export function LiveStatusLine({ status }: { status: { label: string; live: boolean } | null }) {
  if (!status) return null;
  return (
    <p className="inline-flex min-h-7 items-center gap-2 text-sm text-muted" role="status" aria-live="polite">
      <StatusShape status="running" size={10} live={status.live} />
      <span>{status.label}</span>
    </p>
  );
}

export default LiveStatusLine;
