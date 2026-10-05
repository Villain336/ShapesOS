// Every MCP tool's metered action must exist in the credit table: the
// metering service refuses unknown actions, and MCP fails closed on any
// metering refusal — a missing entry silently breaks the tool for everyone.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOL_CREDIT_PASSTHROUGH } from "../scopes";
import { CREDIT_COSTS } from "@/lib/metering/credits";

describe("MCP passthrough actions are in the credit table", () => {
  for (const [tool, { action, credits }] of Object.entries(TOOL_CREDIT_PASSTHROUGH)) {
    it(`${tool} → ${action}`, () => {
      const def = (CREDIT_COSTS as Record<string, { credits: number }>)[action];
      assert.ok(def, `credit table has no "${action}" (used by MCP tool ${tool})`);
      assert.equal(def.credits, credits, `${tool}: passthrough credits match the table`);
    });
  }
});
