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
