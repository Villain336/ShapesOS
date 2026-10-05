"use client";

// ShapesOS — run timeline (kit: agent-blocks.png "Weekly competitor brief").
// Header: title, who started it, status badge, pause + stop. Body: steps
// with their state shape on a connector line (done = green quarter-disc,
// running = blue circle with a progress row, queued = ring), an optional
// tool-call block in JetBrains Mono, and a "will ask you before …" chip on
// steps that stop for approval. Step states come from lib/aos/run-steps.

import type { ReactNode } from "react";
import { Pause, Play, Square } from "lucide-react";
import type { AosStatus } from "@/lib/aos/status";
import { deriveRunSteps, ofCaption, progressFraction, type TimelineStep, type ToolCall } from "@/lib/aos/run-steps";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";
import { StatusShape } from "./StatusShape";

export type { ToolCall, TimelineStep };

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
  onResume,
  onStop,
  pauseLabel = "Pause run",
  resumeLabel = "Resume run",
  busy,
  badge,
  headingLevel = "h3",
  emptyText = "No steps yet.",
  footer,
  className,
}: {
  title: string;
  subtitle?: string;
  status: AosStatus;
  steps: TimelineStep[];
  /** Steps finished so far. */
  completed: number;
  onPause?: () => void;
  /** Paused work: a Resume control (running fill, per the action table). */
  onResume?: () => void;
  onStop?: () => void;
  pauseLabel?: string;
  resumeLabel?: string;
  /** Disables the controls while a pause / resume / stop is in flight. */
  busy?: boolean;
  /** Replaces the status badge (e.g. a neutral "Cancelled" chip). */
  badge?: ReactNode;
  /** "h1" when the timeline is the page's main heading. */
  headingLevel?: "h1" | "h2" | "h3";
  emptyText?: string;
  /** Extra content under the steps (links, notes). */
  footer?: ReactNode;
  className?: string;
}) {
  const derived = deriveRunSteps(steps, { completed, status });
  const Heading = headingLevel;
  const ctl =
    "aos-press flex size-10 shrink-0 items-center justify-center rounded-full disabled:pointer-events-none disabled:bg-disabled disabled:text-disabled-fg disabled:shadow-none";
  return (
    <section className={cn("overflow-hidden rounded-lg bg-paper shadow-hairline", className)} aria-label={title}>
      <header className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-5 sm:flex-nowrap sm:px-6">
        <div className="min-w-0 flex-1 basis-full sm:basis-auto">
          <Heading
            className={cn(
              "leading-snug font-bold stretch-heading tracking-heading text-ink",
              headingLevel === "h1" ? "text-xl" : "text-lg",
            )}
          >
            {title}
          </Heading>
          {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {badge ?? <StatusBadge status={status} />}
          {onPause ? (
            <button type="button" onClick={onPause} disabled={busy} aria-label={pauseLabel} title={pauseLabel} className={cn(ctl, "bg-paper text-ink shadow-outline")}>
              <Pause className="size-4" aria-hidden />
            </button>
          ) : null}
          {onResume ? (
            <button type="button" onClick={onResume} disabled={busy} aria-label={resumeLabel} title={resumeLabel} className={cn(ctl, "bg-running text-paper")}>
              <Play className="size-4 fill-current" aria-hidden />
            </button>
          ) : null}
          {onStop ? (
            <button type="button" onClick={onStop} disabled={busy} aria-label="Stop run" title="Stop run" className={cn(ctl, "bg-failed text-paper")}>
              <Square className="size-3.5 fill-current" aria-hidden />
            </button>
          ) : null}
        </div>
      </header>
      {derived.length === 0 ? <p className="px-5 py-5 text-md text-muted sm:px-6">{emptyText}</p> : null}
      <ol className={cn("px-5 py-5 sm:px-6", derived.length === 0 && "hidden")}>
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
      {footer ? <div className="border-t border-line px-5 py-3.5 sm:px-6">{footer}</div> : null}
    </section>
  );
}

export default RunTimeline;
