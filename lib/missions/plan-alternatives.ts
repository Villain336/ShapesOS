// ShapesOS - plan ALTERNATIVES for a drafted mission. Pure module (no prisma).
//
// Scope, stated plainly: these are VARIANTS of the SAME template plan (declared
// transformations, derived deterministically). They are not independent
// competing plans, not parallel execution in isolated copies, and no model is
// called, so computing them costs nothing. Choosing one only rewrites the drafted plan; the mission
// stays "planned" until a person approves that exact revision.

import type { MissionTemplate, PlanStepDef } from "./templates";

export interface PlanAlternative {
  id: "as-templated" | "drafts-only" | "review-first";
  label: string;
  /** The declared strategy, in words. Not a prediction about speed or cost. */
  strategy: string;
  steps: PlanStepDef[];
  /** Steps in the template plan this alternative leaves out. */
  omitted: string[];
  /** The plan snapshot stored on the mission when this alternative is chosen. */
  snapshot: Record<string, unknown>;
}

// Executors a "drafts only" variant may keep. Source-backed: none of these
// allow-lists contains `actions.invoke` (the only connected-app action tool,
// held by `actor` alone) - asserted against EXECUTOR_ALLOW_LISTS in
// __tests__/plan-alternatives.test.ts. `drafter` also holds
// `mission_approval.create`: it can FILE an approval request, which does
// nothing until a person decides it. `human` is excluded (it is the approval
// gate itself) and so is any executor not listed here.
export const DRAFT_SAFE_EXECUTORS: readonly string[] = ["researcher", "planner", "drafter", "analyst", "scheduler"];

const DRAFTS_ONLY_NOTE = " (In this variant no step sends or publishes; any draft stays a draft for a person to use.)";

function renumber(steps: PlanStepDef[]): PlanStepDef[] {
  return steps.map((s, i) => ({ ...s, order: i + 1 }));
}

export function buildPlanAlternatives(template: MissionTemplate): PlanAlternative[] {
  const base = template.plan.map((s) => ({ ...s }));
  const out: PlanAlternative[] = [
    {
      id: "as-templated",
      label: "Full plan",
      strategy: "The template's default plan, unchanged.",
      steps: base,
      omitted: [],
      // Identical to the snapshot startMission writes, so a fresh draft already matches it.
      snapshot: { templateId: template.id, steps: base },
    },
  ];

  const keep = base.filter((s) => s.tier === 0 && s.kind !== "approval" && DRAFT_SAFE_EXECUTORS.includes(s.executor));
  if (keep.length > 0 && keep.length < base.length) {
    // Retained steps whose prose leans on a removed approval/publish step get a
    // plain note instead of a dangling reference.
    const steps = renumber(keep).map((s) => (/approv|gate|publish|send/i.test(s.description) ? { ...s, description: s.description + DRAFTS_ONLY_NOTE } : s));
    out.push({
      id: "drafts-only",
      label: "Drafts and analysis only",
      strategy: "Keeps research, planning, drafting, analysis and scheduling-proposal steps. Leaves out every step marked as acting outside the workspace and the approval steps that guarded them. A drafting step can still file an approval request; nothing runs unless a person approves it.",
      steps,
      omitted: base.filter((s) => !keep.includes(s)).map((s) => s.title),
      snapshot: { templateId: template.id, alternativeId: "drafts-only", steps },
    });
  }

  if (base.some((s) => !s.checkpointAfter)) {
    const steps = base.map((s) => ({ ...s, checkpointAfter: true }));
    out.push({
      id: "review-first",
      label: "Checkpoint after every step",
      strategy: "The same steps in the same order, each marked with a checkpoint after it. Executors, approval steps and tiers are unchanged, so no approval gate is added, removed or weakened.",
      steps,
      omitted: [],
      snapshot: { templateId: template.id, alternativeId: "review-first", steps },
    });
  }
  return out;
}
