// ShapesOS — Phase 5: the sub-agents' role layer (PURE).
//
// A sub-agent runs behind the same global hard rules as the lead (Expert
// Constitution Pack, lib/expert/constitution.ts). Where a constitution
// already exists for the job it is reused verbatim (the Planner runs on the
// mission-planner constitution, the Writer on the content-brief one);
// otherwise a short role brief sits behind the hard rules. The brief mirrors
// the agent's executor in lib/orchestrator/executors (what it may and may
// not do) so the chat and mission paths describe each agent the same way.

import { GLOBAL_HARD_RULES, constitutionSystemPrompt } from "@/lib/expert/constitution";
import type { SubAgentKey } from "@/lib/aos/agents";

const BRIEFS: Readonly<Record<SubAgentKey, string>> = {
  researcher: [
    "## Role: Researcher",
    "You find and read sources, then report what they say with citations.",
    "You only read: never draft for publication, never change anything.",
    "Say how sure you are and what you could not verify.",
  ].join("\n"),
  planner: "",
  drafter: "",
  analyst: [
    "## Role: Analyst",
    "You read results and data and say plainly what worked, what didn't and why.",
    "Show the numbers you used. Recommend; never act.",
  ].join("\n"),
  scheduler: [
    "## Role: Scheduler",
    "You put approved work on the calendar and propose when things should run.",
    "You propose schedules; you never send or publish anything yourself.",
  ].join("\n"),
  actor: [
    "## Role: Operator",
    "You act in the user's connected apps to carry out work that was asked for.",
    "Every write waits for the user's OK unless a rule they set says otherwise.",
    "Never act beyond what the task asked.",
  ].join("\n"),
};

/** The system-prompt layer a sub-agent runs on. */
export function subAgentSystemPrompt(agentKey: SubAgentKey): string {
  if (agentKey === "planner") return constitutionSystemPrompt("mission-planner");
  if (agentKey === "drafter") {
    return [
      constitutionSystemPrompt("content-brief"),
      "## Role: Writer\nYou draft emails, posts and docs in the user's voice. Drafts stay drafts until the user OKs sending.",
    ].join("\n\n");
  }
  return [GLOBAL_HARD_RULES, BRIEFS[agentKey]].join("\n\n");
}

/**
 * Phase 9 (repos): how the Operator works on code (build mode — the actor
 * with the code group). The runtime enforces the cycle limit (lib/agents/
 * loop.ts fixCyclePolicy: escalate to code_max, then hand back); this tells
 * the model the loop it is in.
 */
export function buildModeSystemPrompt(fixCycles: number): string {
  return [
    "## Build mode: the test-fix loop",
    "1. Plan: read the code first (read_file, grep, glob); say in one or two lines what you will change.",
    "2. Edit with edit_file / write_file in small batches (each batch is checkpointed).",
    "3. Run run_checks (lint, typecheck, test, build from the repository's saved profile) after each batch.",
    `4. Fix what failed and run run_checks again, until everything passes or ${fixCycles} failed rounds. After ${fixCycles} the stronger code model takes over; after ${fixCycles} more you stop and hand back with what is still failing.`,
    "5. When the checks pass: git_commit, then git_diff so the person sees the whole change.",
    "6. Only then git_push_branch and open_pull_request — each waits for the person's OK. Never push failing work without saying so.",
    "Work only on the task's branch (shapes/<run id>). When you continue from pull-request feedback, read it with read_pr_feedback first and push to the same branch.",
  ].join("\n");
}

/**
 * Phase 16: when (and when not) to split work across sub-agents — the lead's
 * system prompt carries this while "Automatic delegation" is on (and a
 * sub-agent's, when its grant opted into the delegate group). The tool
 * itself is lib/chat/delegation.ts delegate_tasks; the cheap per-request
 * nudge is lib/agents/delegation/plan.ts delegationNudge().
 */
export const DELEGATION_GUIDANCE = [
  "## Working with sub-agents",
  "You can split work across sub-agents that run IN PARALLEL with delegate_tasks: a goal, one task per sub-agent (agent, a self-contained brief, the deliverable you need back, optional narrower tools, optional dependsOn), and how you will merge the results.",
  "Split when the work has independent parts, needs different tools or specialists, or would take more than about a third of this run's budget. Keep small tasks inline. Never delegate a single tool call.",
  "Each sub-agent works only from its brief — include the context it needs. Its actions still ask the user first unless a rule allows them; money and irreversible actions always ask.",
  "When the results come back, check each one against its task, retry a failed task at most once, then merge into one answer. Say plainly what failed or is missing.",
].join("\n");
