// Phase 11 (conncore): the MCP server is on by default for paid plans with
// API access (Pro, Agency), off otherwise; an explicit false always wins.
// Run: npx tsx --test lib/mcp/__tests__/mcp-default.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_DEFAULT_ON_PLANS, mcpEffectiveState, mcpPlanDefault } from "../enabled";

describe("MCP server default", () => {
  it("unset → on for Pro and Agency, off for trial, starter, self-hosted and unknown plans", () => {
    assert.deepEqual([...MCP_DEFAULT_ON_PLANS], ["pro", "agency"]);
    for (const plan of ["pro", "agency"]) {
      const s = mcpEffectiveState({ mcpEnabled: null, plan });
      assert.deepEqual(s, { enabled: true, on: true, entitled: true, source: "plan_default", planDefault: true }, plan);
    }
    for (const plan of ["trial", "self_hosted"]) {
      const s = mcpEffectiveState({ mcpEnabled: null, plan });
      assert.equal(s.on, false, plan);
      assert.equal(s.entitled, true, plan);
    }
    assert.equal(mcpEffectiveState({ mcpEnabled: null, plan: "starter" }).enabled, false);
    assert.equal(mcpPlanDefault("enterprise-unknown"), false);
    assert.equal(mcpEffectiveState(null).enabled, false);
  });

  it("an explicit false is the off switch on every plan; true still needs the entitlement", () => {
    for (const plan of ["pro", "agency", "trial", "self_hosted"]) {
      const s = mcpEffectiveState({ mcpEnabled: false, plan });
      assert.equal(s.enabled, false, plan);
      assert.equal(s.source, "explicit_off");
    }
    assert.equal(mcpEffectiveState({ mcpEnabled: true, plan: "trial" }).enabled, true);
    const starter = mcpEffectiveState({ mcpEnabled: true, plan: "starter" });
    assert.equal(starter.on, true);
    assert.equal(starter.enabled, false, "not entitled → closed even when switched on");
  });

  it("every gate reads the shared rule (no raw mcpEnabled truthiness left)", () => {
    const root = join(__dirname, "..", "..", "..");
    for (const f of ["lib/mcp/protocol.ts", "lib/mcp/oauth.ts", "app/api/mcp/keys/route.ts", "app/api/mcp/settings/route.ts"]) {
      const src = readFileSync(join(root, f), "utf8");
      assert.match(src, /mcpEffectiveState\(/, f);
      assert.doesNotMatch(src, /!ws\?\.mcpEnabled|ctx\.workspace\.mcpEnabled\)|mcpEnabled === true,/, f);
    }
    const sql = readFileSync(join(root, "prisma/migrations/20261012200200_p11_conncore_mcp_default/migration.sql"), "utf8");
    assert.match(sql, /DROP NOT NULL/);
    assert.match(sql, /\[mcp\] mcp server disabled%/, "explicit opt-outs are kept");
  });
});
