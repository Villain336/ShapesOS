// ShapesOS — Phase 5: every chat tool has a tool group (and every write an
// automation action), and the prompt catalog only lists granted tools.
// Run: npx tsx --test lib/chat/__tests__/tool-groups.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, TOOL_ACTION, TOOL_GROUP, toolCatalogForPrompt, toolGranted } from "../tools";
import { isToolGroup } from "@/lib/agents/grants";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { KNOWN_ACTIONS } from "@/lib/automation/policy";

describe("tool groups", () => {
  it("every registered tool belongs to a known group (no silent fall-through)", () => {
    for (const t of TOOLS) {
      assert.ok(TOOL_GROUP[t.name], `${t.name} has no tool group`);
      assert.ok(isToolGroup(TOOL_GROUP[t.name]), `${t.name} has an unknown group`);
    }
  });

  it("every non-safe tool names its automation action", () => {
    for (const t of TOOLS.filter((t) => t.kind !== "safe")) {
      assert.ok(TOOL_ACTION[t.name], `${t.name} has no automation action`);
    }
  });

  it("money-moving and external tools map to kinds that always ask (Tier 2+)", () => {
    const settings = { smallActionThresholdCents: 10_000, automationAllows: true };
    for (const name of ["ops_send_invoice", "ops_mark_invoice_paid", "run_workflow", "trigger_automation_flow", "ops_launch_workflow"]) {
      assert.ok(evaluateTier({ kind: TOOL_ACTION[name]! }, settings) >= 2, `${name} must always ask`);
    }
  });

  it("generate_image: media group, spend kind, editor, Tier-0 draft_image (auto-approvable)", () => {
    const t = TOOLS.find((x) => x.name === "generate_image");
    assert.ok(t, "generate_image is registered");
    assert.equal(t!.kind, "spend");
    assert.equal(t!.minRole, "editor");
    assert.equal(TOOL_GROUP.generate_image, "media");
    assert.equal(TOOL_ACTION.generate_image, "draft_image");
    const settings = { smallActionThresholdCents: 10_000, automationAllows: true };
    assert.equal(evaluateTier({ kind: "draft_image" }, settings), 0);
    assert.ok(KNOWN_ACTIONS.some((a) => a.action === "draft_image"), "draft_image is in the automation catalog");
    assert.equal(toolGranted("generate_image", ["workspace", "content"]), false);
    assert.equal(toolGranted("generate_image", ["workspace", "media"]), true);
  });

  it("the prompt catalog lists only granted tools", () => {
    const narrow = toolCatalogForPrompt(["workspace", "email"]);
    assert.match(narrow, /- get_keywords \[/);
    assert.doesNotMatch(narrow, /- research_question \[/);
    assert.doesNotMatch(narrow, /- ops_send_invoice \[/);
    assert.match(toolCatalogForPrompt(), /- research_question \[/);
    assert.equal(toolGranted("research_question", ["workspace"]), false);
    assert.equal(toolGranted("research_question", null), true);
    // Unknown names fall in "connectors": refused unless that group is granted.
    assert.equal(toolGranted("made_up_tool", ["workspace", "web"]), false);
  });
});
