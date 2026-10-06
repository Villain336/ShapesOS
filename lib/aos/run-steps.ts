// ShapesOS — run timeline step states (pure).
//
// A run is an ordered list of steps; how far it got plus the run's overall
// state decide what each step shows: done steps get the green quarter-disc,
// the current step takes the run's state (running circle, needs-you
// triangle, failed square, paused bars), later steps are queued rings.

import type { AosStatus } from "./status";

export interface RunStepInput {
  key?: string;
  title: string;
  detail?: string | null;
  /** Clock time shown at the right ("9:01"). */
  at?: string | null;
  /** The step will stop and ask before acting ("Will ask you before sending"). */
  asksFirst?: boolean;
}

/** A tool call drawn as a JetBrains Mono block under its step. */
export interface ToolCall {
  /** Tool name in mono, e.g. "web.search". */
  name: string;
  /** "0.8 s" */
  duration?: string;
  args?: Array<[string, string]>;
  /** Result line after the arrow. */
  result?: string;
}

/** One step as RunTimeline draws it. */
export interface TimelineStep extends RunStepInput {
  tool?: ToolCall;
  /** Progress inside the current step ("7 of 12"). */
  progress?: { done: number; total: number };
  /** Text for the asks-first chip (default "Will ask you before sending"). */
  asksFirstLabel?: string;
}

export interface DerivedRunStep extends RunStepInput {
  index: number;
  state: AosStatus;
  /** True for the step the run is on now. */
  current: boolean;
}

export interface RunProgressInput {
  /** Steps finished so far. */
  completed: number;
  /** The run's overall state. */
  status: AosStatus;
}

export function clampCompleted(completed: number, total: number): number {
  if (!Number.isFinite(completed)) return 0;
  return Math.min(Math.max(Math.floor(completed), 0), Math.max(total, 0));
}

export function deriveRunSteps(steps: readonly RunStepInput[], progress: RunProgressInput): DerivedRunStep[] {
  const total = steps.length;
  const done = progress.status === "done" ? total : clampCompleted(progress.completed, total);
  return steps.map((step, index) => {
    if (index < done) return { ...step, index, state: "done", current: false };
    if (index === done) {
      const state: AosStatus = progress.status === "done" ? "done" : progress.status;
      return { ...step, index, state, current: true };
    }
    return { ...step, index, state: "queued", current: false };
  });
}

/** 0..1, safe for any input. */
export function progressFraction(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(Math.max(done / total, 0), 1);
}

/** The step being worked on (1-based, never past the end); null when there are no steps. */
export function stepNumbers(completed: number, total: number): { current: number; total: number } | null {
  if (total <= 0) return null;
  return { current: Math.min(clampCompleted(completed, total) + 1, total), total };
}

/** "Step 3 of 7": the step being worked on (1-based), never past the end. */
export function stepCounter(completed: number, total: number): string {
  const n = stepNumbers(completed, total);
  if (!n) return "No steps yet";
  return `Step ${n.current} of ${n.total}`;
}

/** "7 of 12" progress caption. */
export function ofCaption(done: number, total: number): string {
  return `${Math.max(0, Math.floor(done))} of ${Math.max(0, Math.floor(total))}`;
}
