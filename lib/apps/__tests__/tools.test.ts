// ShapesOS — Phase 9 (apps): the mini-app agent tools are registered, grouped
// and gated per the Phase 5 rules (no database).
// Run: npx tsx --test lib/apps/__tests__/tools.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOL_ACTION, TOOL_GROUP, getTool, toolGranted } from "@/lib/chat/tools";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { KNOWN_ACTIONS } from "@/lib/automation/policy";
import { AGENT_MAX_GROUPS } from "@/lib/agents/grants";
import "../tools";

const settings = { smallActionThresholdCents: 10_000, automationAllows: true };

describe("mini-app tools", () => {
  it("are registered with the right kind, role and group", () => {
    const want = {
      app_create_spec: { kind: "publish", group: "ops", action: "draft_app_spec" },
      app_list_records: { kind: "safe", group: "workspace", action: undefined },
      app_upsert_record: { kind: "publish", group: "ops", action: "write_app_record" },
      app_delete_record: { kind: "destructive", group: "ops", action: "delete_app_record" },
    } as const;
    for (const [name, w] of Object.entries(want)) {
      const t = getTool(name);
      assert.ok(t, `${name} is registered`);
      assert.equal(t!.kind, w.kind, name);
      assert.equal(TOOL_GROUP[name], w.group, name);
      assert.equal(TOOL_ACTION[name], w.action, name);
      if (w.kind !== "safe") assert.equal(t!.minRole, "editor", name);
    }
  });

  it("drafting can be auto-approved (Tier 0); record writes and deletes always ask", () => {
    assert.equal(evaluateTier({ kind: "draft_app_spec" }, settings), 0);
    assert.equal(evaluateTier({ kind: "write_app_record" }, settings), 2);
    assert.equal(evaluateTier({ kind: "delete_app_record" }, settings), 3);
    for (const a of ["draft_app_spec", "write_app_record", "delete_app_record"]) {
      assert.ok(KNOWN_ACTIONS.some((k) => k.action === a), `${a} is in the automation catalog`);
    }
  });

  it("the grant decides who sees them: reads with workspace, writes need ops", () => {
    assert.equal(toolGranted("app_list_records", ["workspace"]), true);
    assert.equal(toolGranted("app_upsert_record", ["workspace"]), false);
    assert.equal(toolGranted("app_upsert_record", ["workspace", "ops"]), true);
    assert.ok(AGENT_MAX_GROUPS.actor.includes("ops"), "the Operator can write app records");
    assert.ok(!AGENT_MAX_GROUPS.researcher.includes("ops"), "the Researcher can only read them");
  });

  it("a viewer is refused before anything runs; an unconfirmed delete waits for a person", async () => {
    const ctx = { projectId: "p", workspaceId: "w", userId: "u", role: "viewer" as const, confirmed: false };
    const c1: ChatToolCall = { tool: "app_upsert_record", args: {}, status: "pending_confirmation" };
    await executeTool(ctx, "app_upsert_record", {}, c1);
    assert.equal(c1.status, "skipped_role");
    const c2: ChatToolCall = { tool: "app_delete_record", args: {}, status: "pending_confirmation" };
    await executeTool({ ...ctx, role: "owner" }, "app_delete_record", {}, c2);
    assert.equal(c2.status, "pending_confirmation", "destructive: never runs without a yes");
  });
});
