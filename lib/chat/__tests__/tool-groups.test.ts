// ShapesOS — Phase 5: every chat tool has a tool group (and every write an
// automation action), and the prompt catalog only lists granted tools.
// Run: npx tsx --test lib/chat/__tests__/tool-groups.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, TOOL_ACTION, TOOL_GROUP, allTools, getTool, toolCatalogForPrompt, toolGranted } from "../tools";
// Phase 8: the ship and browser tools register themselves on import.
import "@/lib/ship/tools";
import "@/lib/agents/runs/browser-tools";
// Phase 11 (seotools): SEO, document, analysis and web tools register on import.
import "@/lib/seo/tools";
import "@/lib/documents/tools";
import "@/lib/sandbox/analyze-tool";
import "@/lib/knowledge/contextdev/web-tools";
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

  it("every registered tool, runtime extras included, belongs to a known group", () => {
    for (const t of allTools()) {
      assert.ok(TOOL_GROUP[t.name], `${t.name} has no tool group`);
      assert.ok(isToolGroup(TOOL_GROUP[t.name]), `${t.name} has an unknown group`);
    }
  });

  it("every non-safe tool names its automation action", () => {
    for (const t of allTools().filter((t) => t.kind !== "safe")) {
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

  it("ship tools: local git is code; push and PR are ship + publish + Tier 2 (always ask)", () => {
    const settings = { smallActionThresholdCents: 10_000, automationAllows: true };
    for (const n of ["git_clone", "git_status", "git_diff", "git_commit"]) assert.equal(TOOL_GROUP[n], "code", n);
    for (const n of ["git_push_branch", "open_pull_request", "read_pr_feedback"]) assert.equal(TOOL_GROUP[n], "ship", n);
    for (const [n, action] of [["git_push_branch", "push_branch"], ["open_pull_request", "open_pr"]] as const) {
      const t = getTool(n);
      assert.ok(t, `${n} is registered`);
      assert.equal(t!.kind, "publish");
      assert.equal(TOOL_ACTION[n], action);
      assert.equal(evaluateTier({ kind: action, description: `${n}: ${t!.description}` }, settings), 2, `${n} always asks`);
      assert.equal(KNOWN_ACTIONS.find((a) => a.action === action)?.tier, 2);
    }
    assert.equal(getTool("read_pr_feedback")!.kind, "safe");
    assert.equal(evaluateTier({ kind: "browser_act" }, settings), 2);
    // Pushing needs the ship group: a code-only task can commit but never push.
    assert.equal(toolGranted("git_commit", ["workspace", "code"]), true);
    assert.equal(toolGranted("git_push_branch", ["workspace", "code"]), false);
    assert.equal(toolGranted("git_push_branch", ["workspace", "ship"]), true);
  });

  it("Phase 11 (seotools) tools: groups, actions and tiers", () => {
    const on = { smallActionThresholdCents: 10_000, automationAllows: true };
    const off = { smallActionThresholdCents: 10_000, automationAllows: false };
    const expect: Array<[string, string, string | null, number | null]> = [
      // name, group, action, tier (null = safe tool, no action)
      ["add_structured_data", "site", "draft_structured_data", 0],
      ["validate_structured_data", "site", null, null],
      ["create_document", "content", "draft_document", 0],
      ["create_spreadsheet", "content", "draft_spreadsheet", 0],
      ["web_scrape", "web", "fetch_web_pages", 0],
      ["web_crawl", "web", "fetch_web_pages", 0],
      ["analyze_data", "code", "run_sandbox_command", 2],
    ];
    for (const [name, group, action, tier] of expect) {
      assert.ok(getTool(name), `${name} is registered`);
      assert.equal(TOOL_GROUP[name], group, name);
      if (action) {
        assert.equal(TOOL_ACTION[name], action, name);
        assert.equal(evaluateTier({ kind: action }, on), tier, name);
        assert.ok(KNOWN_ACTIONS.some((a) => a.action === action), `${action} is in the automation catalog`);
      }
    }
    // Submitting a sitemap is the existing Tier-1 "refresh owned page": asks unless automation is on.
    assert.equal(TOOL_GROUP.submit_sitemap, "site");
    assert.equal(TOOL_ACTION.submit_sitemap, "refresh_owned_page");
    assert.equal(evaluateTier({ kind: "refresh_owned_page" }, off), 2);
    assert.equal(evaluateTier({ kind: "refresh_owned_page" }, on), 1);
    assert.equal(TOOL_ACTION.analyze_data, TOOL_ACTION.bash, "analyze_data has bash's tier");
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
