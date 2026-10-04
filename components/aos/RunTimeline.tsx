"use client";

// ShapesOS — run timeline (kit: agent-blocks.png "Weekly competitor brief").
// Header: title, who started it, status badge, pause + stop. Body: steps
// with their state shape on a connector line (done = green quarter-disc,
// running = blue circle with a progress row, queued = ring), an optional
// tool-call block in JetBrains Mono, and a "will ask you before …" chip on
// steps that stop for approval. Step states come from lib/aos/run-steps.

import { Pause, Square } from "lucide-react";
import type { AosStatus } from "@/lib/aos/status";
import { deriveRunSteps, ofCaption, progressFraction, type RunStepInput } from "@/lib/aos/run-steps";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";
import { StatusShape } from "./StatusShape";

export interface ToolCall {
  /** Tool name in mono, e.g. "web.search". */
  name: string;
  /** "0.8 s" */
  duration?: string;
  args?: Array<[string, string]>;
  /** Result line after the arrow. */
  result?: string;
}

export interface TimelineStep extends RunStepInput {
  tool?: ToolCall;
  /** Progress inside the current step ("7 of 12"). */
  progress?: { done: number; total: number };
  /** Text for the asks-first chip (default "Will ask you before sending"). */
  asksFirstLabel?: string;
}

export function ToolCallBlock({ call, className }: { call: ToolCall; className?: string }) {
  return (
    <div className={cn("aos-night aos-mono rounded-md px-4 py-3 text-sm leading-6", className)}>
      <div className="flex items-center justify-between gap-3 text-night-muted">
        <span>{call.name}</span>
        {call.duration ? <span>{call.duration}</span> : null}
      </div>
      {call.args?.map(([k, v]) => (
        <div key={k} className="break-words">
          <span className="text-running-night">{k}</span> <span className="text-paper">{v}</span>
        </div>
      ))}
      {call.result ? (
        <div className="text-paper">
          <span className="text-done-night" aria-hidden>
            →
          </span>{" "}
          {call.result}
        </div>
      ) : null}
    </div>
  );
}

export function AsksFirstChip({ label = "Will ask you before sending" }: { label?: string }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-needs-tint px-2.5 text-xs font-semibold text-ink">
      <StatusShape status="needs" size={10} />
      {label}
    </span>
  );
}

export function RunTimeline({
  title,
  subtitle,
  status,
  steps,
  completed,
  onPause,
  onStop,
  className,
}: {
  title: string;
  subtitle?: string;
  status: AosStatus;
  steps: TimelineStep[];
  /** Steps finished so far. */
  completed: number;
  onPause?: () => void;
  onStop?: () => void;
  className?: string;
}) {
  const derived = deriveRunSteps(steps, { completed, status });
  return (
    <section className={cn("overflow-hidden rounded-lg bg-paper shadow-hairline", className)} aria-label={title}>
      <header className="flex items-start gap-3 border-b border-line px-6 py-5">
        <div className="min-w-0 flex-1">
          <h3 className="text-lg leading-snug font-bold stretch-heading tracking-heading text-ink">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={status} />
          {onPause ? (
            <button
              type="button"
              onClick={onPause}
              aria-label="Pause run"
              className="aos-press flex size-10 items-center justify-center rounded-full bg-paper text-ink shadow-outline"
            >
              <Pause className="size-4" aria-hidden />
            </button>
          ) : null}
          {onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop run"
              className="aos-press flex size-10 items-center justify-center rounded-full bg-failed text-paper"
            >
              <Square className="size-3.5 fill-current" aria-hidden />
            </button>
          ) : null}
        </div>
      </header>
      <ol className="px-6 py-5">
        {derived.map((step, i) => {
          const src = steps[i]!;
          const last = i === derived.length - 1;
          const lineDone = step.state === "done";
          return (
            <li key={step.key ?? step.title} className="relative flex gap-4 pb-5 last:pb-0">
              {/* Connector: the shape, then a line down to the next step. */}
              <div className="relative flex w-3.5 shrink-0 flex-col items-center pt-[3px]">
                <span className={cn(step.state === "queued" && "opacity-55")}>
                  <StatusShape status={step.state} size={step.state === "running" ? 11 : 12} label={`${step.title}: ${step.state}`} />
                </span>
                {!last ? (
                  <span
                    aria-hidden
                    className={cn("mt-2 w-0.5 flex-1", lineDone ? "bg-ink" : "bg-line")}
                    style={{ marginBottom: -14 }}
                  />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-base leading-5 font-semibold text-ink">{step.title}</p>
                  {src.progress && step.current ? (
                    <span className="shrink-0 text-xs font-semibold text-running tabular-nums">{ofCaption(src.progress.done, src.progress.total)}</span>
                  ) : step.at ? (
                    <span className="shrink-0 text-xs text-muted tabular-nums">{step.at}</span>
                  ) : null}
                </div>
                {src.progress && step.current ? (
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-line" aria-hidden>
                    <div className="h-full rounded-full bg-running" style={{ width: `${progressFraction(src.progress.done, src.progress.total) * 100}%` }} />
                  </div>
                ) : null}
                {step.detail ? <p className="mt-1 text-md text-muted">{step.detail}</p> : null}
                {src.tool ? <ToolCallBlock call={src.tool} className="mt-3" /> : null}
                {step.asksFirst ? (
                  <div className="mt-2">
                    <AsksFirstChip label={src.asksFirstLabel} />
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default RunTimeline;
