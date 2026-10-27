// ShapesOS - plan ALTERNATIVES for a drafted mission. Pure module (no prisma).
//
// Scope, stated plainly: these are alternative drafts of the SAME mission plan
// (declared strategies derived deterministically from the template). It is not
// parallel execution in isolated copies and it calls no model, so it costs
// nothing to compute. Choosing one only rewrites the drafted plan; the mission
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

  const keep = base.filter((s) => s.tier === 0 && s.kind !== "approval");
  if (keep.length > 0 && keep.length < base.length) {
    const steps = renumber(keep);
    out.push({
      id: "drafts-only",
      label: "Drafts and analysis only",
      strategy: "Keeps research, planning, drafting and analysis steps. Leaves out every step that acts outside the workspace (and the approval steps that only guard them).",
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
      strategy: "The same steps, with a checkpoint after each one so progress is reviewed more often.",
      steps,
      omitted: [],
      snapshot: { templateId: template.id, alternativeId: "review-first", steps },
    });
  }
  return out;
}
