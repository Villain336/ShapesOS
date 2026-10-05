// ShapesOS Phase 13 (twincore): digital twin agent tools — registered in
// OPS_TOOLS with a tool group, an automation action and the right tier:
// booking a dock and assigning equipment are Tier 1 (an automation rule can
// let them run; without one they ask), drafting a layout is Tier 0, and no
// twin tool is Tier 3 (the descriptions avoid the money / delete verbs).
//   npx tsx --test lib/chat/__tests__/ops-twin-tools.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOL_ACTION, TOOL_GROUP, getTool } from "../tools";
import { OPS_TOOLS } from "../ops-tools";
import { TWIN_OPS_TOOLS } from "../ops-twin-tools";
import { evaluateTier, TIER1_KINDS } from "@/lib/orchestrator/authority";
import { KNOWN_ACTIONS } from "@/lib/automation/policy";

const on = { smallActionThresholdCents: 10_000, automationAllows: true };
const off = { smallActionThresholdCents: 10_000, automationAllows: false };

describe("Phase 13 (twincore) agent tools", () => {
  const expect: Array<[string, "safe" | "publish", string, string | null, number | null, number | null]> = [
    // name, kind, group, action, tier with automation on, tier with it off
    ["twin_site_state", "safe", "workspace", null, null, null],
    ["twin_find", "safe", "workspace", null, null, null],
    ["twin_book_dock", "publish", "ops", "book_dock", 1, 2],
    ["twin_assign_equipment", "publish", "ops", "assign_equipment", 1, 2],
    ["twin_draft_layout", "publish", "ops", "draft_site_layout", 0, 0],
  ];

  it("are registered in OPS_TOOLS with group, action and tier", () => {
    assert.equal(TWIN_OPS_TOOLS.length, expect.length);
    for (const [name, kind, group, action, tierOn, tierOff] of expect) {
      const t = getTool(name);
      assert.ok(t, `${name} is registered`);
      assert.ok(OPS_TOOLS.some((x) => x.name === name), `${name} is an OPS tool`);
      assert.equal(t!.kind, kind, name);
      assert.equal(TOOL_GROUP[name], group, name);
      assert.equal(t!.minRole, kind === "safe" ? "viewer" : "editor", name);
      if (action) {
        assert.equal(TOOL_ACTION[name], action, name);
        const description = `${name}: ${t!.description}`;
        assert.equal(evaluateTier({ kind: action, description }, on), tierOn, `${name} tier (automation on)`);
        assert.equal(evaluateTier({ kind: action, description }, off), tierOff, `${name} tier (automation off)`);
        assert.ok(KNOWN_ACTIONS.some((a) => a.action === action), `${action} is in the automation catalog`);
      } else {
        assert.equal(TOOL_ACTION[name], undefined, `${name} is a read`);
      }
    }
  });

  it("no twin tool is Tier 3, whatever its arguments say about what it serves", () => {
    for (const t of TWIN_OPS_TOOLS) {
      const action = TOOL_ACTION[t.name] ?? "read_twin";
      assert.notEqual(evaluateTier({ kind: action, description: `${t.name}: ${t.description}` }, on), 3, t.name);
    }
    assert.ok(TIER1_KINDS.has("book_dock") && TIER1_KINDS.has("assign_equipment"));
  });
});
