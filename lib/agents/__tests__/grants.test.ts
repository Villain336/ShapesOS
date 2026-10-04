// ShapesOS — Phase 5: tool grants (pure).
// Run: npx tsx --test lib/agents/__tests__/grants.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_KEYS,
  AGENT_MAX_GROUPS,
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
    // Sub-agents can never hand work off.
    for (const k of AGENT_KEYS.filter((k) => k !== "lead")) {
      assert.ok(!computeGrant({ agentKey: k, requested: ["delegate"] }).groups.includes("delegate"), k);
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

  it("maps owned-channel writes to Tier-1 kinds and everything else to a kind that always asks", () => {
    assert.equal(connectorAction("buffer", "create_post"), "post_owned_social");
    assert.equal(connectorAction("wordpress", "save_content"), "publish_owned");
    assert.equal(connectorAction("buffer", "delete_post"), "delete_social_post");
    assert.equal(connectorAction("my-mcp", "send_invoice"), "connector_write");
  });
});
