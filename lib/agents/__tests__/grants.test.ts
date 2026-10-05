// ShapesOS — Phase 5: tool grants (pure).
// Run: npx tsx --test lib/agents/__tests__/grants.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_KEYS,
  AGENT_MAX_GROUPS,
  ALWAYS_GRANTED,
  TOOL_GROUPS,
  computeGrant,
  connectorAction,
  connectorGroup,
  isGroupGranted,
} from "../grants";

describe("computeGrant", () => {
  it("gives an agent its defaults when no tools are asked for", () => {
    assert.deepEqual(computeGrant({ agentKey: "researcher" }).groups, [...AGENT_MAX_GROUPS.researcher]);
    assert.deepEqual(computeGrant({ agentKey: "lead", requested: [] }).groups, [...TOOL_GROUPS]);
  });

  it("narrows to the asked-for groups plus reading the workspace", () => {
    const g = computeGrant({ agentKey: "drafter", requested: ["email"] });
    assert.deepEqual(g.groups, ["workspace", "email"]);
    assert.deepEqual(g.dropped, []);
  });

  it("keeps the lead's hand-off ability when it is narrowed", () => {
    assert.deepEqual(computeGrant({ agentKey: "lead", requested: ["web"] }).groups, ["workspace", "web", "delegate"]);
  });

  it("never grants beyond the agent's maximum, and says what it dropped", () => {
    const g = computeGrant({ agentKey: "planner", requested: ["web", "calendar", "nonsense"] });
    assert.deepEqual(g.groups, ["workspace", "calendar"]);
    assert.deepEqual(g.dropped.sort(), ["nonsense", "web"]);
    // Phase 16: sub-agents never hand work off by default; "delegate" is an
    // opt-in group (depth 2) granted only when asked for by name, and only
    // inside a parent grant that has it.
    for (const k of AGENT_KEYS.filter((k) => k !== "lead")) {
      assert.ok(!computeGrant({ agentKey: k }).groups.includes("delegate"), `${k} default`);
      assert.ok(!computeGrant({ agentKey: k, requested: ["web"] }).groups.includes("delegate"), `${k} narrowed`);
      assert.ok(computeGrant({ agentKey: k, requested: ["delegate"] }).groups.includes("delegate"), `${k} opt-in`);
      const noHandOff = computeGrant({ agentKey: k, requested: ["delegate"], parentGrant: ["workspace", "web"] });
      assert.ok(!noHandOff.groups.includes("delegate"), `${k} beyond its parent`);
      assert.ok(noHandOff.dropped.includes("delegate"));
    }
  });

  it("a child never gets more than its parent", () => {
    const parent = computeGrant({ agentKey: "lead", requested: ["email"] }).groups; // workspace, email, delegate
    const child = computeGrant({ agentKey: "researcher", parentGrant: parent });
    assert.deepEqual(child.groups, ["workspace"]);
    const asked = computeGrant({ agentKey: "actor", requested: ["email", "social"], parentGrant: parent });
    assert.deepEqual(asked.groups, ["workspace", "email"]);
    assert.ok(asked.dropped.includes("social"));
    for (const k of AGENT_KEYS) {
      for (const g of computeGrant({ agentKey: k, parentGrant: parent }).groups) {
        assert.ok(parent.includes(g), `${k} got ${g} outside its parent`);
      }
    }
  });

  it("media (image generation): the lead, the Writer and the Operator only", () => {
    assert.ok(TOOL_GROUPS.includes("media"));
    for (const k of ["lead", "drafter", "actor"] as const) {
      assert.ok(AGENT_MAX_GROUPS[k].includes("media"), `${k} should be able to generate images`);
    }
    for (const k of ["researcher", "planner", "analyst", "scheduler"] as const) {
      assert.ok(!AGENT_MAX_GROUPS[k].includes("media"), `${k} should not generate images`);
    }
    assert.deepEqual(computeGrant({ agentKey: "drafter", requested: ["media"] }).groups, ["workspace", "media"]);
    assert.deepEqual(computeGrant({ agentKey: "researcher", requested: ["media"] }).dropped, ["media"]);
  });

  it("ship (push, pull requests): the lead and the Operator only, never always granted", () => {
    assert.ok(TOOL_GROUPS.includes("ship"));
    assert.ok(!ALWAYS_GRANTED.includes("ship"));
    for (const k of ["lead", "actor"] as const) assert.ok(AGENT_MAX_GROUPS[k].includes("ship"), `${k} may ship`);
    for (const k of ["researcher", "planner", "drafter", "analyst", "scheduler"] as const) {
      assert.ok(!AGENT_MAX_GROUPS[k].includes("ship"), `${k} must not ship`);
    }
    assert.deepEqual(computeGrant({ agentKey: "actor", requested: ["ship"] }).groups, ["workspace", "ship"]);
    assert.deepEqual(computeGrant({ agentKey: "actor", requested: ["code"] }).groups, ["workspace", "code"], "code without ship can't push");
    assert.deepEqual(computeGrant({ agentKey: "analyst", requested: ["ship"] }).dropped, ["ship"]);
    // A narrowed parent without ship never hands it down.
    const parent = computeGrant({ agentKey: "lead", requested: ["code"] }).groups;
    assert.ok(!computeGrant({ agentKey: "actor", requested: ["ship"], parentGrant: parent }).groups.includes("ship"));
  });

  it("a null grant means role checks only (legacy callers)", () => {
    assert.equal(isGroupGranted(null, "ops"), true);
    assert.equal(isGroupGranted(["workspace"], "ops"), false);
  });
});

describe("connectors", () => {
  it("files each connector under one group; unknown connectors fall under connected apps", () => {
    assert.equal(connectorGroup("gmail"), "email");
    assert.equal(connectorGroup("dataforseo"), "web");
    assert.equal(connectorGroup("google-search-console"), "data");
    assert.equal(connectorGroup("buffer"), "social");
    assert.equal(connectorGroup("my-mcp-server"), "connectors");
  });

  it("maps owned-channel writes to Tier-1 kinds and everything else to a per-connector write_<key> switch (Phase 14)", () => {
    assert.equal(connectorAction("buffer", "create_post"), "post_owned_social");
    assert.equal(connectorAction("wordpress", "save_content"), "publish_owned");
    assert.equal(connectorAction("buffer", "delete_post"), "delete_social_post");
    assert.equal(connectorAction("my-mcp", "send_invoice"), "write_my_mcp");
    assert.equal(connectorAction("slack", "post_message"), "write_slack");
    // Money connectors: an unmapped write is a Tier-3 kind (never auto).
    assert.equal(connectorAction("quickbooks", "anything_new"), "money_connector_write");
    assert.equal(connectorAction("gusto", "anything_new"), "money_connector_write");
  });
});
