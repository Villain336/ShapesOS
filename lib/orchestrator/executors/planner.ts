// Marketr — Phase 9 M2: Planner executor (SPEC §P9A).
//
// PROPOSES ONLY — executes nothing. Turns a mission goal into a sequenced
// plan JSON with checkpoints. The plan is validated by schema: every step
// carries status "proposed", and any execution marker (executed / sent /
// published / ...) fails validation. The module has no dispatch, execute,
// or send tools in its allow-list, so it cannot act even if asked.

import { z } from "zod";
import {
  assertToolAllowed,
  checkKillSwitchesFirst,
  estimateCostCents,
  type GuardDeps,
} from "./_guard";
// Phase 10 M9: Expert Constitution Pack v1 — the mission planner's
// system-prompt layer. The M2 planner is deterministic (defaultCompose),
// but any LLM composer swapped in behind the PlannerInput.compose
// contract MUST use MISSION_PLANNER_SYSTEM_PROMPT as its system prompt,
// with M9 retrieval grounding placed after it (see groundedPrompt()).
import { constitutionSystemPrompt } from "@/lib/expert/constitution";

/**
 * The mission planner's system-prompt layer (Expert Constitution Pack v1:
 * global hard rules + mission-planner constitution). Any LLM composer
 * behind PlannerInput.compose must send this as the system prompt, with
 * retrieval grounding after it — never before.
 */
export const MISSION_PLANNER_SYSTEM_PROMPT =
  constitutionSystemPrompt("mission-planner");

export const PLANNER_TOOLS = Object.freeze([
  "substrate.context",
  "plan.validate",
  "checkpoint.define",
]) as readonly string[];

export type PlanExecutorName = "researcher" | "planner" | "drafter" | "analyst" | "scheduler";

const PlanStepSchema = z.object({
  id: z.string().min(1),
  executor: z.enum(["researcher", "planner", "drafter", "analyst", "scheduler"]),
  task: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string()).default([]),
  /** Every step is a proposal. Anything else fails validation. */
  status: z.literal("proposed"),
});

const CheckpointSchema = z.object({
  id: z.string().min(1),
  afterStep: z.string().min(1),
  kind: z.enum(["review", "approval", "verify", "budget"]),
  condition: z.string().min(1),
});

export const MissionPlanSchema = z
  .object({
    goal: z.string().min(1),
    steps: z.array(PlanStepSchema).min(1),
    checkpoints: z.array(CheckpointSchema).default([]),
    successMetrics: z.array(z.string()).default([]),
    budgetCents: z.number().int().nonnegative().default(10_000),
  })
  .superRefine((plan, ctx) => {
    // No executed side effects may hide in the plan JSON — the serialized
    // plan must not contain execution markers. This is the code-enforced
    // half of "proposes only".
    const banned = ["executed", "sent", "published", "approved_execute", "dispatched", "transmitted"];
    const serialized = JSON.stringify(plan).toLowerCase();
    for (const marker of banned) {
      if (serialized.includes(`"${marker}"`) || serialized.includes(`${marker}:true`)) {
        ctx.addIssue({
          code: "custom",
          message: `Planner output must never contain executed side effects (found "${marker}").`,
        });
      }
    }
    // dependsOn must reference real step ids (no dangling edges).
    const ids = new Set(plan.steps.map((s) => s.id));
    for (const step of plan.steps) {
      for (const dep of step.dependsOn) {
        if (!ids.has(dep)) {
          ctx.addIssue({ code: "custom", message: `Step "${step.id}" depends on unknown step "${dep}".` });
        }
      }
    }
  });

export type MissionPlan = z.infer<typeof MissionPlanSchema>;

/**
 * assertNoExecutionMarkers — scans the RAW composer output for execution
 * markers before schema parsing (zod strips unknown keys on parse, so the
 * scan must run first). The planner proposes; it must never emit anything
 * that looks like an executed side effect.
 */
const BANNED_EXECUTION_MARKERS = [
  "executed",
  "sent",
  "published",
  "approved_execute",
  "dispatched",
  "transmitted",
];

export function assertNoExecutionMarkers(raw: unknown): void {
  const serialized = JSON.stringify(raw ?? {}).toLowerCase();
  for (const marker of BANNED_EXECUTION_MARKERS) {
    if (serialized.includes(`"${marker}"`) || serialized.includes(`${marker}:true`)) {
      throw new Error(
        `Planner output must never contain executed side effects (found "${marker}").`,
      );
    }
  }
}

export interface PlannerInput {
  workspaceId: string;
  missionId?: string | null;
  goal: string;
  budgetCents?: number;
  /**
   * Optional composer override (tests / future LLM composer behind the same
   * contract). An LLM composer MUST use MISSION_PLANNER_SYSTEM_PROMPT
   * (exported above) as its system prompt, with any M9 retrieval grounding
   * placed after the constitution — see groundedPrompt() in
   * lib/expert/constitution.ts.
   */
  compose?: (goal: string, budgetCents: number) => MissionPlan | Promise<MissionPlan>;
}

export interface PlannerDeps extends GuardDeps {}

export interface PlannerResult {
  executor: "planner";
  plan: MissionPlan;
  summary: string;
  costCents: number;
}

/**
 * defaultCompose — deterministic plan skeleton (M2 has no LLM composer).
 * Maps the goal onto the standard mission arc: research → analyze →
 * draft → schedule, with a review checkpoint before any draft and a
 * budget checkpoint at the end. M3+ may swap in an LLM composer behind
 * the same (goal, budget) -> validated-plan contract.
 */
function defaultCompose(goal: string, budgetCents: number): MissionPlan {
  const raw = {
    goal,
    budgetCents,
    steps: [
      {
        id: "s1_research",
        executor: "researcher",
        task: "research",
        inputs: { query: goal },
        dependsOn: [],
        status: "proposed",
      },
      {
        id: "s2_analyze",
        executor: "analyst",
        task: "analyze",
        inputs: { hypothesis: `Baseline for: ${goal}` },
        dependsOn: ["s1_research"],
        status: "proposed",
      },
      {
        id: "s3_draft",
        executor: "drafter",
        task: "draft",
        inputs: { brief: goal },
        dependsOn: ["s2_analyze"],
        status: "proposed",
      },
      {
        id: "s4_schedule",
        executor: "scheduler",
        task: "schedule",
        inputs: {},
        dependsOn: ["s3_draft"],
        status: "proposed",
      },
    ],
    checkpoints: [
      {
        id: "c1_review_draft",
        afterStep: "s3_draft",
        kind: "review",
        condition: "Human reviews the draft before anything external.",
      },
      {
        id: "c2_budget",
        afterStep: "s4_schedule",
        kind: "budget",
        condition: `Cumulative cost must stay under ${budgetCents}¢.`,
      },
    ],
    successMetrics: [`Progress toward: ${goal}`],
  };
  return MissionPlanSchema.parse(raw);
}

export async function runPlanner(
  input: PlannerInput,
  deps: PlannerDeps = {},
): Promise<PlannerResult> {
  await checkKillSwitchesFirst(input, deps);
  assertToolAllowed("planner", PLANNER_TOOLS, "plan.validate");
  if (!input.goal?.trim()) throw new Error("planner: goal is required.");

  const budgetCents = input.budgetCents ?? 10_000;
  const compose = input.compose ?? defaultCompose;
  const drafted = await compose(input.goal.trim(), budgetCents);
  // Enforcement order matters: marker scan on the RAW output first (zod
  // strips unknown keys), then schema validation of the parsed plan.
  assertNoExecutionMarkers(drafted);
  assertToolAllowed("planner", PLANNER_TOOLS, "checkpoint.define");
  const plan = MissionPlanSchema.parse(drafted);

  const summary =
    `Plan for "${plan.goal}": ${plan.steps.length} proposed step(s) ` +
    `(${plan.steps.map((s) => `${s.id}→${s.executor}`).join(", ")}), ` +
    `${plan.checkpoints.length} checkpoint(s), budget ${plan.budgetCents}¢. ` +
    `Nothing executed — all steps are proposals awaiting routing.`;

  return {
    executor: "planner",
    plan,
    summary,
    costCents: estimateCostCents(input.goal.length, JSON.stringify(plan).length),
  };
}
