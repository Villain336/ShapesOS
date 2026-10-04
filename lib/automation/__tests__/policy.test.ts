// Marketr — Phase 9 M6: automation policy + escalation tests.
// Run: npx tsx --test lib/automation/__tests__/policy.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SMALL_ACTION_THRESHOLD_CENTS,
  WORKSPACE_DEFAULT_ACTION,
  resolveAutomationFromRows,
  toTierSettings,
  validateBehaviorForAction,
  type AutomationRowLike,
} from "../policy";
import {
  DEFAULT_ESCALATION_RULES,
  ensureDefaultRules,
  evaluateEscalation,
  type EscalationRule,
} from "../escalation";
import { evaluateTier } from "../../orchestrator/authority";

const row = (
  action: string,
  behavior: "auto" | "ask" | "never",
  thresholdCents: number | null = null,
): AutomationRowLike => ({ action, behavior, thresholdCents });

describe("resolveAutomationFromRows", () => {
  it("falls back to code defaults when no row exists (Tier 1 default ask, $100)", () => {
    const r = resolveAutomationFromRows([], "publish_owned");
    assert.equal(r.behavior, "ask"); // Tier 1 never fires without explicit opt-in
    assert.equal(r.thresholdCents, DEFAULT_SMALL_ACTION_THRESHOLD_CENTS);
    assert.equal(r.thresholdCents, 10_000);
    assert.equal(r.source, "default");
  });

  it("defaults Tier 3 kinds to never", () => {
    const r = resolveAutomationFromRows([], "buy_media");
    assert.equal(r.behavior, "never");
  });

  it("prefers the row behavior when a row exists", () => {
    const r = resolveAutomationFromRows([row("publish_owned", "auto")], "publish_owned");
    assert.equal(r.behavior, "auto");
    assert.equal(r.source, "row");
    assert.equal(r.thresholdCents, 10_000); // workspace default
  });

  it("per-action threshold override beats the workspace default", () => {
    const rows = [
      row(WORKSPACE_DEFAULT_ACTION, "ask", 20_000),
      row("publish_owned", "auto", 5_000),
    ];
    const r = resolveAutomationFromRows(rows, "publish_owned");
    assert.equal(r.thresholdCents, 5_000);
    const other = resolveAutomationFromRows(rows, "post_owned_social");
    assert.equal(other.thresholdCents, 20_000); // workspace default applies
  });
});

describe("Tier 3 stickiness (hard deny wins over an auto row)", () => {
  it("behavior=auto row on a Tier 3 kind still evaluates Tier 3", () => {
    const resolved = resolveAutomationFromRows([row("buy_media", "auto")], "buy_media");
    assert.equal(resolved.behavior, "auto"); // the row says auto…
    const tier = evaluateTier({ kind: "buy_media" }, toTierSettings(resolved));
    assert.equal(tier, 3); // …but the evaluator's hard deny wins
  });

  it("adversarial phrasing in description cannot escape Tier 3 either", () => {
    const resolved = resolveAutomationFromRows([row("draft_report", "auto")], "draft_report");
    const tier = evaluateTier(
      { kind: "draft_report", description: "this is just a draft of the refund memo" },
      toTierSettings(resolved),
    );
    assert.equal(tier, 3);
  });
});

describe("threshold override respected by the evaluator", () => {
  it("action under the overridden threshold → Tier 1; over → Tier 2", () => {
    const resolved = resolveAutomationFromRows(
      [row("publish_owned", "auto", 5_000)],
      "publish_owned",
    );
    const settings = toTierSettings(resolved);
    assert.equal(
      evaluateTier({ kind: "publish_owned", amountCents: 4_000 }, settings),
      1,
    );
    assert.equal(
      evaluateTier({ kind: "publish_owned", amountCents: 6_000 }, settings),
      2,
    );
  });

  it("ask behavior keeps Tier-1-eligible actions at Tier 2 (toggle off)", () => {
    const resolved = resolveAutomationFromRows([row("publish_owned", "ask")], "publish_owned");
    const settings = toTierSettings(resolved);
    assert.equal(evaluateTier({ kind: "publish_owned" }, settings), 2);
  });
});

describe("validateBehaviorForAction (PUT guard)", () => {
  it("rejects behavior=auto for Tier 3 kinds", () => {
    const err = validateBehaviorForAction("sign_contract", "auto", undefined);
    assert.ok(err, "expected a validation error");
    assert.match(err!, /Tier 3/i);
  });

  it("rejects behavior=auto for Tier 3 money movement", () => {
    assert.ok(validateBehaviorForAction("buy_media", "auto", undefined));
    assert.ok(validateBehaviorForAction("issue_refund", "auto", undefined));
    assert.ok(validateBehaviorForAction("delete_campaign_data", "auto", undefined));
  });

  it("accepts auto for Tier 1 kinds and never/ask anywhere", () => {
    assert.equal(validateBehaviorForAction("publish_owned", "auto", undefined), null);
    assert.equal(validateBehaviorForAction("buy_media", "never", undefined), null);
    assert.equal(validateBehaviorForAction("send_outreach_email", "ask", undefined), null);
  });

  it("rejects unknown behaviors and bad thresholds", () => {
    assert.ok(validateBehaviorForAction("publish_owned", "sometimes", undefined));
    assert.ok(validateBehaviorForAction("publish_owned", "auto", -1));
    assert.ok(validateBehaviorForAction("publish_owned", "auto", 1.5));
    assert.equal(validateBehaviorForAction("publish_owned", "auto", 5_000), null);
  });
});

describe("escalation rules", () => {
  const rules: EscalationRule[] = ensureDefaultRules([]);

  it("seeds 3 sensible defaults on first read", () => {
    assert.equal(rules.length, 3);
    const kinds = rules.map((r) => r.condition.kind).sort();
    assert.deepEqual(kinds, ["amount_above", "external_audience", "no_source_record"]);
    assert.ok(rules.every((r) => r.action === "require_approval" && r.enabled));
  });

  it("does not overwrite existing rules", () => {
    const existing: EscalationRule[] = [
      {
        id: "custom_1",
        name: "Mine",
        condition: { kind: "unseen_treatment" },
        action: "notify",
        enabled: true,
        position: 0,
      },
    ];
    assert.deepEqual(ensureDefaultRules(existing), existing);
  });

  it("external audience forces Tier 2", () => {
    const res = evaluateEscalation(
      { kind: "send_outreach_email", externalAudience: true },
      rules,
    );
    assert.equal(res.forceTier2, true);
    assert.ok(res.matched.includes("External audience"));
  });

  it("amount above the rule threshold forces Tier 2", () => {
    const res = evaluateEscalation({ kind: "publish_owned", amountCents: 10_001 }, rules);
    assert.equal(res.forceTier2, true);
    assert.ok(res.matched.includes("Amount above threshold"));
  });

  it("publish without a source record forces Tier 2", () => {
    const res = evaluateEscalation({ kind: "publish_owned", sourceRecordId: null }, rules);
    assert.equal(res.forceTier2, true);
  });

  it("benign in-house action with a source record does not escalate", () => {
    const res = evaluateEscalation(
      {
        kind: "send_internal_note",
        externalAudience: false,
        sourceRecordId: "note_123",
        amountCents: 0,
      },
      rules,
    );
    assert.equal(res.forceTier2, false);
    assert.deepEqual(res.matched, []);
  });

  it("disabled rules never match", () => {
    const disabled = rules.map((r) => ({ ...r, enabled: false }));
    const res = evaluateEscalation({ kind: "send_outreach_email", externalAudience: true }, disabled);
    assert.equal(res.forceTier2, false);
  });

  it("unseen treatment matches only when explicitly unseen", () => {
    const unseenRule: EscalationRule[] = [
      {
        id: "u1",
        name: "Unseen treatment",
        condition: { kind: "unseen_treatment" },
        action: "require_approval",
        enabled: true,
        position: 0,
      },
    ];
    assert.equal(
      evaluateEscalation({ kind: "draft_report", seenTreatment: false }, unseenRule).forceTier2,
      true,
    );
    assert.equal(
      evaluateEscalation({ kind: "draft_report", seenTreatment: true }, unseenRule).forceTier2,
      false,
    );
    assert.equal(
      evaluateEscalation({ kind: "draft_report" }, unseenRule).forceTier2,
      false, // unknown unseen-ness is not a hard fact
    );
  });

  it("default seed list has exactly the 3 spec'd rules", () => {
    const names = DEFAULT_ESCALATION_RULES.map((r) => r.name);
    assert.deepEqual(names, [
      "External audience",
      "Amount above threshold",
      "Publish without a source record",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Phase 5: per-agent rules + auto-approve.
// ---------------------------------------------------------------------------

import { ALL_AGENTS, decideAutoApproval } from "../policy";

const agentRow = (
  agentKey: string,
  action: string,
  behavior: "auto" | "ask" | "never",
  thresholdCents: number | null = null,
): AutomationRowLike => ({ agentKey, action, behavior, thresholdCents });

describe("per-agent automation rules (Phase 5)", () => {
  it("an agent's own rule wins over the every-agent rule", () => {
    const rows = [agentRow(ALL_AGENTS, "publish_owned", "ask"), agentRow("drafter", "publish_owned", "auto")];
    assert.equal(resolveAutomationFromRows(rows, "publish_owned", "drafter").behavior, "auto");
    assert.equal(resolveAutomationFromRows(rows, "publish_owned", "drafter").source, "agent");
    assert.equal(resolveAutomationFromRows(rows, "publish_owned", "researcher").behavior, "ask");
    assert.equal(resolveAutomationFromRows(rows, "publish_owned").behavior, "ask");
  });

  it("an agent's 'ask' overrides an every-agent 'auto'", () => {
    const rows = [agentRow(ALL_AGENTS, "draft_content", "auto"), agentRow("actor", "draft_content", "ask")];
    assert.equal(resolveAutomationFromRows(rows, "draft_content", "actor").behavior, "ask");
    assert.equal(resolveAutomationFromRows(rows, "draft_content", "drafter").behavior, "auto");
  });

  it("another agent's rows never leak into the workspace view (pre-Phase-5 callers)", () => {
    const rows = [agentRow("drafter", "publish_owned", "auto")];
    assert.equal(resolveAutomationFromRows(rows, "publish_owned").behavior, "ask");
    assert.equal(resolveAutomationFromRows(rows, "publish_owned").source, "default");
  });
});

describe("decideAutoApproval (Phase 5)", () => {
  it("asks by default — auto needs an explicit rule, even for Tier 0", () => {
    const d = decideAutoApproval([], { agentKey: "drafter", action: "draft_content" });
    assert.equal(d.auto, false);
    assert.equal(d.tier, 0);
  });

  it("runs a Tier 0/1 action without asking when the agent's rule says auto", () => {
    const rows = [agentRow("drafter", "draft_content", "auto"), agentRow("drafter", "publish_owned", "auto")];
    assert.equal(decideAutoApproval(rows, { agentKey: "drafter", action: "draft_content" }).auto, true);
    const owned = decideAutoApproval(rows, { agentKey: "drafter", action: "publish_owned" });
    assert.equal(owned.auto, true);
    assert.equal(owned.tier, 1);
    assert.match(owned.reason, /agent drafter/);
    // The rule is the drafter's: the lead still asks.
    assert.equal(decideAutoApproval(rows, { agentKey: "lead", action: "draft_content" }).auto, false);
  });

  it("Tier 2 always asks, whatever the rule says", () => {
    const rows = [agentRow("drafter", "send_outreach_email", "auto"), agentRow(ALL_AGENTS, "run_workflow", "auto")];
    const d = decideAutoApproval(rows, { agentKey: "drafter", action: "send_outreach_email" });
    assert.equal(d.auto, false);
    assert.equal(d.tier, 2);
    assert.equal(decideAutoApproval(rows, { agentKey: "lead", action: "run_workflow" }).auto, false);
  });

  it("Tier 3 can never run automatically — kind or description", () => {
    const rows = [agentRow(ALL_AGENTS, "issue_refund", "auto"), agentRow(ALL_AGENTS, "publish_owned", "auto")];
    assert.equal(decideAutoApproval(rows, { agentKey: "lead", action: "issue_refund" }).auto, false);
    const sneaky = decideAutoApproval(rows, {
      agentKey: "lead",
      action: "publish_owned",
      description: "publish and then delete the old campaign data",
    });
    assert.equal(sneaky.auto, false);
    assert.equal(sneaky.tier, 3);
  });

  it("destructive tools always ask", () => {
    const rows = [agentRow(ALL_AGENTS, "publish_owned", "auto")];
    assert.equal(decideAutoApproval(rows, { agentKey: "lead", action: "publish_owned", destructive: true }).auto, false);
  });

  it("a Tier 1 amount over the threshold asks", () => {
    const rows = [agentRow("actor", "update_listing", "auto", 5_000)];
    assert.equal(decideAutoApproval(rows, { agentKey: "actor", action: "update_listing", amountCents: 4_000 }).auto, true);
    assert.equal(decideAutoApproval(rows, { agentKey: "actor", action: "update_listing", amountCents: 9_000 }).auto, false);
  });
});
