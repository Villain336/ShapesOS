// ShapesOS — Phase 16: a delegation plan as the UI draws it (PURE).
//
// The run page's plan table, the chat's "Working with N sub-agents" card and
// the agent tree read a delegating run's agentState.delegation through this
// one view-model: each task with its agent, its state (status colour + shape
// — these ARE agent states, DESIGN.md), what it depends on, its budget and
// what it used, and its deliverable or why it failed.

import type { DelegationState } from "@/lib/agents/delegation/store";
import {
  delegationProgress,
  progressLine,
  type Budget,
  type DelegationProgress,
  type DelegationTaskStatus,
} from "@/lib/agents/delegation/plan";
import { SUB_AGENTS } from "./agents";
import type { AosStatus } from "./status";

export interface DelegationTaskView {
  id: string;
  agent: string;
  agentName: string;
  status: DelegationTaskStatus;
  /** The status shape to draw (null = neutral: stopped). */
  aos: AosStatus | null;
  /** Sentence-case state word ("Needs you", "Stopped"). */
  label: string;
  brief: string;
  deliverableSpec: string;
  dependsOn: string[];
  budget: Budget;
  used: { costMicroUsd: number; steps: number } | null;
  summary: string | null;
  confidence: string | null;
  openIssues: string[];
  error: string | null;
  childRunId: string | null;
  href: string | null;
  grant: string[];
  dropped: string[];
  fixes: string | null;
}

export interface DelegationPlanView {
  planId: string;
  goal: string;
  mergeInstructions: string;
  round: number;
  joined: boolean;
  progress: DelegationProgress;
  /** "3 of 5 sub-agents done". */
  line: string;
  reserve: Budget;
  tasks: DelegationTaskView[];
}

export interface DelegationView {
  runId: string;
  runStatus: string;
  /** Still working or waiting (the card keeps polling / the SSE keeps streaming). */
  live: boolean;
  plans: DelegationPlanView[];
}

export function taskAosStatus(s: DelegationTaskStatus): AosStatus | null {
  switch (s) {
    case "pending":
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "awaiting_confirmation":
      return "needs";
    case "succeeded":
      return "done";
    case "failed":
    case "skipped":
      return "failed";
    default:
      return null; // cancelled: neutral, never a status colour
  }
}

const LABELS: Record<DelegationTaskStatus, string> = {
  pending: "Waiting to start",
  queued: "Starting",
  running: "Running",
  awaiting_confirmation: "Needs you",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  skipped: "Skipped",
};

export function taskStatusLabel(s: DelegationTaskStatus): string {
  return LABELS[s];
}

/** "8 calls · ≈$0.27 · 4 min". */
export function formatBudget(b: Pick<Budget, "costMicroUsd" | "steps"> & { ms?: number }): string {
  const parts = [`${b.steps} call${b.steps === 1 ? "" : "s"}`, `≈$${(b.costMicroUsd / 1_000_000).toFixed(2)}`];
  if (typeof b.ms === "number") parts.push(`${Math.max(1, Math.round(b.ms / 60_000))} min`);
  return parts.join(" · ");
}

const LIVE_RUN = new Set(["queued", "running", "awaiting_confirmation"]);

export function buildDelegationView(runId: string, runStatus: string, state: DelegationState | null): DelegationView {
  const plans: DelegationPlanView[] = (state?.plans ?? []).map((p) => {
    const progress = delegationProgress(p.tasks);
    return {
      planId: p.planId,
      goal: p.goal,
      mergeInstructions: p.mergeInstructions,
      round: p.round,
      joined: !!p.joinedAt,
      progress,
      line: progressLine(progress),
      reserve: p.reserve,
      tasks: p.tasks.map((t) => ({
        id: t.id,
        agent: t.agent,
        agentName: (SUB_AGENTS as Record<string, { name: string }>)[t.agent]?.name ?? t.agent,
        status: t.status,
        aos: taskAosStatus(t.status),
        label: taskStatusLabel(t.status),
        brief: t.brief,
        deliverableSpec: t.deliverableSpec,
        dependsOn: t.dependsOn,
        budget: t.budget,
        used: t.costMicroUsd !== undefined || t.steps !== undefined ? { costMicroUsd: t.costMicroUsd ?? 0, steps: t.steps ?? 0 } : null,
        summary: t.deliverable?.summary ?? null,
        confidence: t.deliverable ? t.deliverable.confidence : null,
        openIssues: t.deliverable?.openIssues ?? [],
        error: t.error ?? null,
        childRunId: t.childRunId ?? null,
        href: t.childRunId ? `/dashboard/runs/${t.childRunId}` : null,
        grant: t.grant,
        dropped: t.dropped,
        fixes: t.fixes ?? null,
      })),
    };
  });
  return { runId, runStatus, live: LIVE_RUN.has(runStatus), plans };
}

/** All tasks of every plan (the tree's "N of M" counts a fix round too). */
export function viewProgress(view: Pick<DelegationView, "plans">): DelegationProgress {
  return delegationProgress(view.plans.flatMap((p) => p.tasks));
}
