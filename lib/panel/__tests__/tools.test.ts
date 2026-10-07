// Phase 19B (WS=panel) — the Dress Rehearsal agent tools and their tiers.
//   list_rehearsal_runs — safe, viewer, Tier 0 (a read).
//   start_page_walk     — costs credits: "spend" kind (the confirmation gate),
//                         editor, Tier 2 (asks; a per-agent rule may auto-run
//                         it — it is not money or irreversible), and the
//                         run's hard cap is still required and enforced.
// The tier is evaluated the way the approval executor does: the action kind
// AND "<tool name>: <description>" are scanned for Tier-3 words.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, TOOL_ACTION, TOOL_GROUP, getTool } from "@/lib/chat/tools";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { KNOWN_ACTIONS } from "@/lib/automation/policy";

const settings = { smallActionThresholdCents: 10_000, automationAllows: true };
const tierOf = (name: string) => {
  const t = getTool(name)!;
  return evaluateTier({ kind: TOOL_ACTION[name]!, description: `${t.name}: ${t.description}` }, settings);
};

describe("Dress Rehearsal agent tools", () => {
  it("list_rehearsal_runs: a Tier-0 read for any member", () => {
    const t = TOOLS.find((x) => x.name === "list_rehearsal_runs");
    assert.ok(t);
    assert.deepEqual([t!.kind, t!.minRole, TOOL_GROUP.list_rehearsal_runs], ["safe", "viewer", "workspace"]);
    assert.equal(tierOf("list_rehearsal_runs"), 0);
  });

  it("start_page_walk: spend kind, editor, Tier 2 — never Tier 3, and listed for per-agent rules", () => {
    const t = TOOLS.find((x) => x.name === "start_page_walk");
    assert.ok(t);
    assert.deepEqual([t!.kind, t!.minRole, TOOL_GROUP.start_page_walk, TOOL_ACTION.start_page_walk], ["spend", "editor", "web", "run_page_walk"]);
    assert.equal(tierOf("start_page_walk"), 2);
    assert.ok(KNOWN_ACTIONS.some((a) => a.action === "run_page_walk"));
  });

  it("start_page_walk requires a credit cap, personas and a target", () => {
    const t = getTool("start_page_walk")!;
    assert.deepEqual([...(t.argsSchema.required ?? [])].sort(), ["capCredits", "personaIds", "target"]);
  });

  it("start_page_walk refuses to run without a positive cap, before touching anything", async () => {
    const t = getTool("start_page_walk")!;
    const res = await t.execute({ workspaceId: "ws", userId: "u", role: "editor" } as never, { target: "https://example.com", personaIds: ["p1"], capCredits: 0 });
    assert.match(res.summary, /credit cap/);
  });
});
