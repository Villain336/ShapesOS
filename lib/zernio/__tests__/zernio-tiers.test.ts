// Phase 15.4 (zernio): the tier of EVERY Zernio tool, pinned. Money law
// (owner, 2026-10-05): creating an ad and anything that raises or restarts
// spend is Tier 3 — never automatable, whatever a rule says; pausing (it
// stops delivery), lowering a budget (proved by a live read), lead forms and
// audiences are Tier 2 (auto only with a rule); reads are Tier 0.
// The evaluation uses the same inputs the connector gate uses: the action
// from connectorAction() and "<tool name>: <tool description>" (the tier
// trap — a money word in a description would push a tool to Tier 3).
// Run: npx tsx --test lib/zernio/__tests__/zernio-tiers.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ZERNIO_TOOLS, ZernioAdapter } from "@/lib/connectors/m21/native/zernio";
import { connectorAction, connectorGroup } from "@/lib/agents/grants";
import { KNOWN_ACTION_DEFS } from "@/lib/automation/actions";
import { autoAllowedFor, decideAutoApproval, validateBehaviorForAction, type AutomationRowLike } from "@/lib/automation/policy";
import { TIER3_EXACT_KINDS, evaluateTier, normalizeForTier } from "@/lib/orchestrator/authority";
import { resolveAdapter } from "@/lib/connectors/m21/registry";

const ON = { smallActionThresholdCents: 10_000, automationAllows: true };
const auto = (action: string): AutomationRowLike => ({ agentKey: "*", action, behavior: "auto", thresholdCents: null });
const describeTool = (name: string) => {
  const t = ZERNIO_TOOLS.find((x) => x.name === name)!;
  return `${t.name}: ${t.description}`;
};

/** tool → [action the gate uses, intrinsic tier]. Reads never reach the gate. */
const EXPECTED: Record<string, { action: string | null; tier: 0 | 2 | 3 }> = {
  accounts: { action: null, tier: 0 },
  ads_accounts: { action: null, tier: 0 },
  ads_campaigns: { action: null, tier: 0 },
  ads_insights: { action: null, tier: 0 },
  ads_create: { action: "buy_media", tier: 3 },
  ads_resume: { action: "resume_ad_campaign", tier: 3 },
  ads_update_budget: { action: "update_campaign_budget", tier: 3 },
  ads_pause: { action: "pause_ad_campaign", tier: 2 },
  ads_create_lead_form: { action: "write_ad_lead_form", tier: 2 },
  ads_create_audience: { action: "write_ad_audience", tier: 2 },
};

describe("Phase 15.4: the tier of every Zernio tool", () => {
  it("covers exactly the adapter's tools", () => {
    assert.deepEqual(ZERNIO_TOOLS.map((t) => t.name).sort(), Object.keys(EXPECTED).sort());
    assert.deepEqual(resolveAdapter("zernio").listTools().map((t) => t.name).sort(), Object.keys(EXPECTED).sort());
  });

  for (const [tool, want] of Object.entries(EXPECTED)) {
    it(`${tool} → ${want.action ?? "read"} → Tier ${want.tier}`, () => {
      const def = ZERNIO_TOOLS.find((t) => t.name === tool)!;
      if (want.action === null) {
        assert.equal(def.mutating, false, "reads are not mutating, so they run without asking (Tier 0)");
        assert.equal(evaluateTier({ kind: `read_${tool}`, description: describeTool(tool) }, ON), 0);
        return;
      }
      assert.equal(def.mutating, true);
      const action = connectorAction("zernio", tool);
      assert.equal(action, want.action);
      assert.ok(KNOWN_ACTION_DEFS.some((d) => d.action === action), `${action} is a Settings → Automation row`);
      // The kind alone and with the tool's own name + description (what the gate sends).
      assert.equal(evaluateTier({ kind: action }, ON), want.tier, `${action} alone`);
      assert.equal(evaluateTier({ kind: action, description: describeTool(tool) }, ON), want.tier, `${action} + description (tier trap)`);
      // A forced "auto" rule: Tier 3 still asks, Tier 2 may run.
      const d = decideAutoApproval([auto(action)], { agentKey: "lead", action, description: describeTool(tool) });
      assert.equal(d.auto, want.tier !== 3, `${tool}: auto with a rule only below Tier 3`);
      if (want.tier === 3) {
        assert.equal(d.offerAuto, false, "never offered 'do this without asking'");
        assert.equal(autoAllowedFor(action), false);
        assert.ok(validateBehaviorForAction(action, "auto", undefined), "the settings API refuses auto for it");
      }
    });
  }

  it("a budget LOWERED (proved by a live read) is Tier 2; raised is Tier 3", () => {
    assert.equal(evaluateTier({ kind: "lower_campaign_budget", description: describeTool("ads_update_budget") }, ON), 2);
    assert.equal(decideAutoApproval([auto("lower_campaign_budget")], { agentKey: "lead", action: "lower_campaign_budget", description: describeTool("ads_update_budget") }).auto, true);
    assert.equal(evaluateTier({ kind: "update_campaign_budget", description: describeTool("ads_update_budget") }, ON), 3);
    assert.equal(decideAutoApproval([auto("update_campaign_budget")], { agentKey: "lead", action: "update_campaign_budget" }).auto, false);
    assert.ok(KNOWN_ACTION_DEFS.some((d) => d.action === "lower_campaign_budget"));
  });

  it("resuming is pinned in TIER3_EXACT_KINDS (no money verb in its name)", () => {
    assert.ok(TIER3_EXACT_KINDS.has(normalizeForTier("resume_ad_campaign")));
    assert.ok(TIER3_EXACT_KINDS.has(normalizeForTier("update_campaign_budget")));
    assert.equal(evaluateTier({ kind: "buy_media" }, ON), 3);
  });

  it("any other Zernio write fails closed to a Tier-3 kind", () => {
    const action = connectorAction("zernio", "some_future_write");
    assert.equal(action, "money_connector_write");
    assert.equal(evaluateTier({ kind: action }, ON), 3);
    assert.equal(decideAutoApproval([auto(action)], { agentKey: "lead", action }).auto, false);
  });

  it("Zernio is a connected app (lead + the Operator), and its adapter refines the budget action only from a live read", async () => {
    assert.equal(connectorGroup("zernio"), "connectors");
    const a = new ZernioAdapter();
    assert.equal(typeof a.resolveAction, "function");
    assert.equal(typeof a.preflight, "function");
    // Not the budget tool → no refinement (the static action stands).
    assert.equal(await a.resolveAction("ads_pause", {}, { workspaceId: "w", userId: "u" }), null);
    assert.equal(await a.resolveAction("ads_create", {}, { workspaceId: "w", userId: "u" }), null);
  });
});
