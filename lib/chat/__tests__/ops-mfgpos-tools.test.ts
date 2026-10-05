// ShapesOS Phase 12 (mfgpos): manufacturing + point-of-sale agent tools —
// registered in OPS_TOOLS with a group, an automation action and the right
// tier: a draft MO is Tier 0, confirming / logging time always ask (Tier 2),
// completing an MO and closing a till session are Tier 3 (never automated);
// money tools propose only (fail-closed if a service ever executed).
//   npx tsx --test lib/chat/__tests__/ops-mfgpos-tools.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOL_ACTION, TOOL_GROUP, getTool } from "../tools";
import { OPS_TOOLS, moneyWriteResult } from "../ops-tools";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { KNOWN_ACTIONS } from "@/lib/automation/policy";

const on = { smallActionThresholdCents: 10_000, automationAllows: true };

describe("Phase 12 (mfgpos) agent tools", () => {
  const expect: Array<[string, "safe" | "publish", string, string | null, number | null]> = [
    // name, kind, group, action, tier
    ["ops_list_manufacturing_orders", "safe", "workspace", null, null],
    ["ops_pos_overview", "safe", "workspace", null, null],
    ["ops_create_manufacturing_order", "publish", "ops", "draft_manufacturing_order", 0],
    ["ops_confirm_manufacturing_order", "publish", "ops", "confirm_manufacturing_order", 2],
    ["ops_log_work_time", "publish", "ops", "log_work_order_time", 2],
    ["ops_complete_manufacturing_order", "publish", "ops", "complete_manufacturing_order", 3],
    ["ops_close_pos_session", "publish", "ops", "close_pos_session", 3],
  ];

  it("are registered in OPS_TOOLS with group, action and tier", () => {
    for (const [name, kind, group, action, tier] of expect) {
      const t = getTool(name);
      assert.ok(t, `${name} is registered`);
      assert.ok(OPS_TOOLS.some((x) => x.name === name), `${name} is an OPS tool`);
      assert.equal(t!.kind, kind, name);
      assert.equal(TOOL_GROUP[name], group, name);
      if (action) {
        assert.equal(TOOL_ACTION[name], action, name);
        // The description travels with the kind (the label is untrusted) — still the same tier.
        assert.equal(evaluateTier({ kind: action, description: `${name}: ${t!.description}` }, on), tier, `${name} tier`);
        assert.ok(KNOWN_ACTIONS.some((a) => a.action === action), `${action} is in the automation catalog`);
      }
      assert.equal(t!.minRole, kind === "safe" ? "viewer" : "editor", name);
    }
  });

  it("Tier 3 holds even with automation off for every rule", () => {
    const off = { smallActionThresholdCents: 10_000, automationAllows: false };
    assert.equal(evaluateTier({ kind: "complete_manufacturing_order" }, off), 3);
    assert.equal(evaluateTier({ kind: "close_pos_session" }, off), 3);
  });

  it("money tools never report an executed write as success", () => {
    assert.throws(() => moneyWriteResult({ outcome: "done", row: { id: "mo" }, action: "gate_executed" }), /refusing to report success/);
    const r = moneyWriteResult({ outcome: "approval_required", approval: { id: "appr_1", status: "pending", riskTier: "high" }, classification: { mode: "gated", tier: "medium", slug: "OPS_MO_COMPLETE", label: "Complete manufacturing order", reason: "x" } });
    assert.equal((r.details as { approvalId: string }).approvalId, "appr_1");
  });
});
