// Marketr — Phase 13D Worker A: kill-switch tests.
// Run: npx tsx --test lib/voice/__tests__/kill-switch.test.ts
// Pure core (isAgentLiveBlocked) — no DB, no network.
// Contract: killSwitch ON → all new sessions refused. Paused/archived
// agents also refuse. Only active + killSwitch off passes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isAgentLiveBlocked } from "../agents";

describe("isAgentLiveBlocked", () => {
  it("kill switch on → blocked (kill_switch_on)", () => {
    const r = isAgentLiveBlocked({ killSwitch: true, status: "active" });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, "kill_switch_on");
  });

  it("kill switch on + paused → still blocked as kill switch", () => {
    const r = isAgentLiveBlocked({ killSwitch: true, status: "paused" });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, "kill_switch_on");
  });

  it("paused agent (no kill switch) → blocked (agent_paused)", () => {
    const r = isAgentLiveBlocked({ killSwitch: false, status: "paused" });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, "agent_paused");
  });

  it("archived agent → blocked (agent_archived)", () => {
    const r = isAgentLiveBlocked({ killSwitch: false, status: "archived" });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, "agent_archived");
  });

  it("active agent, kill switch off → not blocked", () => {
    const r = isAgentLiveBlocked({ killSwitch: false, status: "active" });
    assert.equal(r.blocked, false);
    assert.equal(r.reason, undefined);
  });
});
