// ShapesOS — ⌘K kit sections (Phase 4d): Agents, Actions keycaps, Tools.
// Run: npx tsx --test components/command-bar/__tests__/palette-kit.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SECTION_ORDER,
  agentCommandItems,
  groupBySection,
  hotkeyParts,
  isTypingTarget,
  toolCommandItems,
  type ConnectorSummary,
} from "../lib";
import { LEAD_AGENT, SUB_AGENTS, type AgentNode } from "@/lib/aos/agents";

function node(over: Partial<AgentNode> & Pick<AgentNode, "key" | "name" | "status">): AgentNode {
  return {
    monogram: over.name[0]!,
    isLead: false,
    line: "Working on it",
    href: "/dashboard/missions/m1",
    updatedAt: "2026-10-04T12:00:00Z",
    missionId: "m1",
    missionName: "Q3 brief",
    progress: null,
    description: "",
    tools: [],
    ...over,
  };
}

describe("palette sections", () => {
  it("leads with Agents, Actions and Tools, then Go and Records", () => {
    assert.deepEqual(SECTION_ORDER.slice(0, 5), ["agents", "actions", "tools", "go", "records"]);
  });
});

describe("agentCommandItems", () => {
  it("puts the lead first, then sub-agents in delegation order, with state and status", () => {
    const tree = {
      lead: node({ key: "lead", name: "Strategist", isLead: true, status: "needs", line: "1 approval waiting on you" }),
      branches: [
        node({ key: "researcher", name: "Researcher", status: "running", line: "reading sources", progress: { done: 2, total: 7 } }),
        node({ key: "drafter", name: "Writer", status: "needs", line: "Waiting for your approval" }),
        node({ key: "actor", name: "Operator", status: "failed", line: "Calendar access expired", href: null }),
      ],
    };
    const items = agentCommandItems(tree);
    assert.deepEqual(items.map((i) => i.title), ["Strategist", "Researcher", "Writer", "Operator"]);
    assert.deepEqual(items.map((i) => i.status), ["needs", "running", "needs", "failed"]);
    assert.equal(items[1]!.subtitle, "Step 3 of 7 · reading sources");
    assert.equal(items[0]!.action, "go");
    assert.equal(items[0]!.agentKey, "lead");
    // No link for its work: Enter hands it a new task instead.
    assert.equal(items[3]!.action, "new-task");
    assert.equal(items[3]!.agentKey, "actor");
    assert.ok(items.every((i) => i.section === "agents"));
  });

  it("with nothing running, offers the lead and every sub-agent as hand-off targets (no status)", () => {
    const items = agentCommandItems(null);
    assert.equal(items[0]!.title, LEAD_AGENT.name);
    assert.equal(items.length, 1 + Object.keys(SUB_AGENTS).length);
    assert.ok(items.every((i) => i.action === "new-task" && !i.status));
    assert.deepEqual(items.slice(1).map((i) => i.agentKey), Object.keys(SUB_AGENTS));
  });
});

describe("toolCommandItems", () => {
  const c = (key: string, displayName: string, connections: ConnectorSummary["connections"], description: string | null = null): ConnectorSummary => ({
    key,
    displayName,
    description,
    connections,
  });

  it("shows connected tools first, then the ones to reconnect; skips never-connected", () => {
    const items = toolCommandItems([
      c("gcal", "Calendar", [{ status: "needs_reauth", meta: null }]),
      c("gmail", "Email", [{ status: "active", meta: { email: "jordan@northwind.co" } }]),
      c("hubspot", "HubSpot", []),
      c("slack", "Slack", [{ status: "revoked" }, { status: "active", meta: { label: "Team" } }]),
      c("x", "X", [{ status: "revoked" }]),
    ]);
    assert.deepEqual(
      items.map((i) => [i.title, i.toolState, i.subtitle]),
      [
        ["Email", "connected", "jordan@northwind.co"],
        ["Slack", "connected", "Team"],
        ["Calendar", "reconnect", "Access expired"],
        ["X", "reconnect", "Access revoked"],
      ],
    );
    assert.ok(items.every((i) => i.href === "/dashboard/settings/connectors" && i.section === "tools"));
  });

  it("offers one Connect a tool row when nothing is connected", () => {
    const items = toolCommandItems([c("hubspot", "HubSpot", [])]);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, "Connect a tool");
    assert.equal(items[0]!.toolState, undefined);
  });
});

describe("keycaps + shortcuts", () => {
  it("splits combos and sequences", () => {
    assert.deepEqual(hotkeyParts("⌘N"), ["⌘", "N"]);
    assert.deepEqual(hotkeyParts("G I"), ["G", "I"]);
    assert.deepEqual(hotkeyParts("⌥1"), ["⌥", "1"]);
    assert.deepEqual(hotkeyParts(undefined), []);
  });

  it("never fires single-key sequences while typing", () => {
    assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
    assert.equal(isTypingTarget({ tagName: "textarea" }), true);
    assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
    assert.equal(isTypingTarget(null), false);
  });

  it("the palette keeps the original hotkeys and adds ⌘N, ⌘J, G I", () => {
    const src = readFileSync(new URL("../CommandBar.tsx", import.meta.url), "utf8");
    for (const k of ['hotkey: "⌥M"', 'hotkey: "⌥P"', 'hotkey: "⌘N"', 'hotkey: "⌘J"', 'hotkey: "G I"']) {
      assert.ok(src.includes(k), `missing ${k}`);
    }
  });

  it("groups agents above actions above tools", () => {
    const groups = groupBySection([
      { id: "t", section: "tools", title: "Email", action: "go", href: "/x" },
      { id: "a", section: "actions", title: "New task", action: "new-task" },
      { id: "g", section: "agents", title: "Strategist", action: "new-task" },
    ]);
    assert.deepEqual(groups.map((g) => g.label), ["Agents", "Actions", "Tools"]);
  });
});
