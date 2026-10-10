// Phase 21A round 2 (WS=agentweb): a taught flow becomes a workflow DRAFT through the existing
// Automations drafter's validation (validateDraft): a manual trigger and one "run an agent tool"
// step that runs the flow. No typed values are baked in, and the tool is not an "always asks" one.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "../../tools"; // registers the agent web tools
import { flowWorkflowDraft } from "../draft";
import { validateDraft } from "@/lib/automations/describe";
import { allTools, toolAction } from "@/lib/chat/tools";
import { agentToolTier } from "@/lib/store/catalogue";
import { NEVER_AUTO_ACTIONS } from "@/lib/automation/policy";
import type { FlowSpec } from "../spec";

const spec: FlowSpec = {
  v: 1,
  name: "Find boots",
  origin: "https://shop.test",
  params: [
    { key: "p1", label: "Search", sensitive: false },
    { key: "p2", label: "Password", sensitive: true },
  ],
  steps: [
    { kind: "navigate", url: "https://shop.test/" },
    { kind: "type", locator: { role: "textbox", name: "Search" }, param: "p1" },
  ],
};
const ctx = { workspaceId: "w1", projects: [{ id: "pr1", name: "shop.test" }], skills: [], timezone: "UTC" };

describe("flowWorkflowDraft", () => {
  it("is a valid workflow draft: a manual trigger and one step that runs the published flow", () => {
    const raw = flowWorkflowDraft({ id: "f1", name: "Find boots", spec }, { projectId: "pr1", timezone: "UTC" });
    const v = validateDraft(raw, ctx, allTools());
    assert.equal(v.ok, true, JSON.stringify(!v.ok && v.problems));
    if (!v.ok || v.draft.format !== "workflow") return;
    const step = v.draft.workflow.nodes.find((n) => n.type === "run_agent_tool")!;
    assert.equal(step.config.tool, "web_flow_run");
    const args = JSON.parse(String(step.config.args)) as { flowId: string; params: Record<string, string> };
    assert.equal(args.flowId, "f1");
    assert.deepEqual(args.params, { p1: "" }); // the person fills values in; a sensitive one is never part of it
    assert.match(v.draft.why, /Password/);
  });
  it("web_flow_run is not an always-asks tool, and it is not Tier 3", () => {
    const tool = allTools().find((t) => t.name === "web_flow_run")!;
    assert.ok(tool, "web_flow_run is registered");
    const e = agentToolTier(tool, toolAction(tool.name), NEVER_AUTO_ACTIONS);
    assert.equal(e.alwaysAsks, false);
    assert.ok(e.tier < 3);
  });
});
