// ShapesOS — Phase 18.3 (WS=trust): agent app permissions in the grant
// arithmetic (unit, pure).
// Run: npx tsx --test lib/agents/__tests__/app-permissions.test.ts
//
//   grant(blocked) = grant(no block) − blocked        (never wider than before)
//   child grant ⊆ parent grant, with or without a block (never wider than parent)
//   "workspace" can't be blocked; unknown names are ignored; a blocked app
//   shows as unavailable in the composer / agent picker.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_KEYS,
  ALWAYS_GRANTED,
  BLOCKABLE_GROUPS,
  BLOCKED_FOR_AGENTS_REASON,
  TOOL_GROUPS,
  blockableGroups,
  computeGrant,
  isGroupBlocked,
  unavailableGroups,
  type AgentKey,
  type ToolGroup,
} from "../grants";

/** Deterministic pseudo-random subsets (no test flakiness). */
function* subsets(seed: number, n: number): Generator<ToolGroup[]> {
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    yield TOOL_GROUPS.filter((_, j) => (x >> j) & 1);
  }
}

const requests: Array<readonly string[] | null> = [null, [], ["email"], ["web", "email", "calendar"], ["files", "ops", "nonsense"], [...TOOL_GROUPS]];

describe("agent app permissions: grant arithmetic", () => {
  it("BLOCKABLE_GROUPS is everything except the always-granted workspace reads", () => {
    assert.ok(!BLOCKABLE_GROUPS.includes("workspace"));
    assert.equal(BLOCKABLE_GROUPS.length, TOOL_GROUPS.length - ALWAYS_GRANTED.length);
    assert.deepEqual(blockableGroups(["workspace", "email", "bogus", "email"]), ["email"]);
    assert.equal(isGroupBlocked(["email"], "email"), true);
    assert.equal(isGroupBlocked(["workspace"], "workspace"), false);
    assert.equal(isGroupBlocked(null, "email"), false);
  });

  it("an empty block list changes nothing (today's behaviour)", () => {
    for (const agentKey of AGENT_KEYS) {
      for (const requested of requests) {
        assert.deepEqual(computeGrant({ agentKey, requested, blockedGroups: [] }), computeGrant({ agentKey, requested }));
        assert.deepEqual(computeGrant({ agentKey, requested, blockedGroups: null }), computeGrant({ agentKey, requested }));
      }
    }
  });

  it("a block removes exactly the blocked apps — never wider than before", () => {
    for (const agentKey of AGENT_KEYS) {
      for (const requested of requests) {
        for (const blocked of subsets(agentKey.length * 7919, 40)) {
          const before = computeGrant({ agentKey, requested }).groups;
          const after = computeGrant({ agentKey, requested, blockedGroups: blocked }).groups;
          const expected = before.filter((g) => !blocked.includes(g) || ALWAYS_GRANTED.includes(g));
          assert.deepEqual(after, expected, `${agentKey} ${JSON.stringify(requested)} − ${blocked.join(",")}`);
          for (const g of after) assert.ok(before.includes(g), "never wider");
          assert.ok(after.includes("workspace"), "workspace reads always stay");
        }
      }
    }
  });

  it("a delegated child is never wider than its parent, block or not", () => {
    for (const parentKey of AGENT_KEYS) {
      for (const blocked of subsets(31337, 25)) {
        const parent = computeGrant({ agentKey: parentKey, requested: null, blockedGroups: blocked }).groups;
        for (const childKey of AGENT_KEYS.filter((k) => k !== "lead") as AgentKey[]) {
          for (const requested of requests) {
            const child = computeGrant({ agentKey: childKey, requested, parentGrant: parent, blockedGroups: blocked }).groups;
            for (const g of child) assert.ok(parent.includes(g), `${childKey} under ${parentKey} got ${g}`);
            for (const g of blocked) if (!ALWAYS_GRANTED.includes(g)) assert.ok(!child.includes(g), `blocked ${g} leaked to ${childKey}`);
          }
        }
      }
    }
  });

  it("an explicitly requested blocked app is reported as dropped", () => {
    const g = computeGrant({ agentKey: "lead", requested: ["email", "web"], blockedGroups: ["email"] });
    assert.ok(!g.groups.includes("email"));
    assert.ok(g.groups.includes("web"));
    assert.ok(g.dropped.includes("email"));
  });

  it("a blocked app shows as unavailable in the composer and the agent picker", () => {
    const why = unavailableGroups({ code: { ok: true }, blocked: ["email"] });
    assert.equal(why.get("email"), BLOCKED_FOR_AGENTS_REASON);
    assert.equal(why.has("web"), false);
    assert.equal(why.has("code"), false);
    assert.equal(unavailableGroups({ code: { ok: true }, blocked: ["workspace"] }).has("workspace"), false);
  });
});
