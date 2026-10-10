// ShapesOS — Phase 21A round 2 (WS=agentweb): a taught flow as a workflow DRAFT (PURE).
//
// The draft goes through the Automations drafter's own validation (lib/automations/describe.ts
// validateDraft) and the Automations app's own Create routes, so a taught flow is just another
// reviewed, switched-off workflow. Typed values are never part of it: each non-sensitive parameter
// is an empty slot the person fills in on the step; a sensitive one (password, card) is not in the
// draft at all, because an agent never types it.

import type { FlowSpec } from "./spec";

export const FLOW_TOOL = "web_flow_run";

export function flowWorkflowDraft(flow: { id: string; name: string; spec: FlowSpec }, ctx: { projectId: string; timezone: string }): Record<string, unknown> {
  const slots = Object.fromEntries(flow.spec.params.filter((p) => !p.sensitive).map((p) => [p.key, ""]));
  const asks = flow.spec.params.filter((p) => !p.sensitive).map((p) => p.label);
  const person = flow.spec.params.filter((p) => p.sensitive).map((p) => p.label);
  const why = [
    `Runs the taught flow "${flow.name}" on ${flow.spec.origin}.`,
    asks.length ? `Fill in the values on the step: ${asks.join(", ")}.` : "",
    person.length ? `${person.join(", ")} is never typed for you: the run stops there for you to do it.` : "",
    "The page decides what is allowed: it stops for a person to confirm sending, and never pays or signs in. It starts off; turn it on after you check it.",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    format: "workflow",
    name: flow.name.slice(0, 120),
    why,
    workflow: {
      projectId: ctx.projectId,
      timezone: ctx.timezone,
      nodes: [
        { key: "t1", kind: "trigger", type: "manual", label: "Run by hand", config: {} },
        { key: "a1", kind: "action", type: "run_agent_tool", label: `Run flow: ${flow.name}`.slice(0, 120), config: { tool: FLOW_TOOL, args: JSON.stringify({ flowId: flow.id, params: slots }) } },
      ],
      edges: [{ from: "t1", to: "a1" }],
    },
  };
}
