// ShapesOS — Phase 14 (approvals): auto-approve for every non-money action.
//
// The owner's hard rule (2026-10-05): a rule set to Auto-run may let ANY
// Tier 0, 1 or 2 action run without asking; money and irreversible actions
// (Tier 3: TIER3_EXACT_KINDS + TIER3_PATTERNS) and destructive tools NEVER
// become auto-approvable. This file proves it over the whole catalog, every
// chat tool and every built-in connector write.
// Run: npx tsx --test lib/automation/__tests__/p14-auto-approve.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_AGENTS,
  DEFAULT_BEHAVIORS,
  KNOWN_ACTIONS,
  NEVER_AUTO_ACTIONS,
  autoAllowedFor,
  decideAutoApproval,
  defaultBehavior,
  resolveAutomationFromRows,
  validateBehaviorForAction,
  type AutomationRowLike,
} from "../policy";
import { KNOWN_ACTION_DEFS, actionGroup } from "../actions";
import { TIER3_EXACT_KINDS, evaluateTier, normalizeForTier } from "@/lib/orchestrator/authority";
import { MONEY_CONNECTOR_KEYS, connectorAction } from "@/lib/agents/grants";
import { DEFAULT_MCP_ACTION, MCP_ASSIGNABLE_ACTIONS, mcpToolAction } from "@/lib/connectors/m21/mcp-policy";
import { mcpToolToDef } from "@/lib/connectors/m21/mcp";
import { listBuiltinConnectors, resolveAdapter } from "@/lib/connectors/m21/registry";
import { allTools, toolAction } from "@/lib/chat/tools";
// Registers the tools other modules add (sandbox, ship, apps, sites …).
import "@/lib/chat/agent";

const ON = { smallActionThresholdCents: 10_000, automationAllows: true };
const auto = (action: string, agentKey = ALL_AGENTS, thresholdCents: number | null = null): AutomationRowLike => ({
  agentKey,
  action,
  behavior: "auto",
  thresholdCents,
});

describe("Phase 14: the tier × rule matrix over every known action", () => {
  for (const a of KNOWN_ACTIONS) {
    it(`${a.action} (Tier ${a.tier})`, () => {
      // A forced "auto" row — for every agent AND for one agent — the worst case.
      const rows = [auto(a.action), auto(a.action, "actor")];
      const forced = decideAutoApproval(rows, { agentKey: "actor", action: a.action });
      const forcedAll = decideAutoApproval(rows, { agentKey: "lead", action: a.action });
      const none = decideAutoApproval([], { agentKey: "actor", action: a.action });
      const destructive = decideAutoApproval(rows, { agentKey: "actor", action: a.action, destructive: true });

      // Destructive never runs without asking.
      assert.equal(destructive.auto, false, "destructive");
      assert.equal(destructive.offerAuto, false, "destructive is never offered");

      if (a.tier === 3) {
        assert.equal(forced.auto, false, "Tier 3 never auto, even with a forced row");
        assert.equal(forcedAll.auto, false);
        assert.equal(forced.tier, 3);
        assert.equal(forced.offerAuto, false, "Tier 3 is never offered");
        assert.equal(a.autoAllowed, false);
        assert.ok(validateBehaviorForAction(a.action, "auto", undefined), "PUT refuses auto for Tier 3");
        assert.equal(defaultBehavior(a.action), "never");
        return;
      }
      if (NEVER_AUTO_ACTIONS.has(a.action)) {
        assert.equal(forced.auto, false);
        assert.equal(forced.offerAuto, false);
        assert.equal(a.autoAllowed, false);
        assert.ok(validateBehaviorForAction(a.action, "auto", undefined));
        return;
      }
      // Tier 0–2: auto only with a rule (or an explicit code default).
      assert.equal(forced.auto, true, `Tier ${a.tier} runs under an auto rule: ${forced.reason}`);
      assert.equal(forcedAll.auto, true);
      assert.match(forced.reason, new RegExp(`auto-approved by the ${a.action} rule for agent actor`));
      assert.equal(forced.offerAuto, true, "Tier 0–2 is offered");
      assert.equal(none.offerAuto, true, "offered even before any rule exists (the Tier-1 offer bug)");
      assert.equal(none.auto, DEFAULT_BEHAVIORS[a.action] === "auto", "no rule → asks (unless an explicit default)");
      assert.equal(a.autoAllowed, true);
      assert.equal(validateBehaviorForAction(a.action, "auto", undefined), null);
      // An "ask" rule for this agent beats an every-agent "auto".
      const askOwn = decideAutoApproval([auto(a.action), { agentKey: "actor", action: a.action, behavior: "ask", thresholdCents: null }], {
        agentKey: "actor",
        action: a.action,
      });
      assert.equal(askOwn.auto, false);
    });
  }

  it("every catalog row has a settings group and a sentence-case label", () => {
    for (const d of KNOWN_ACTION_DEFS) {
      assert.ok(["agents", "ops", "connectors", "slack"].includes(actionGroup(d.action)), d.action);
      assert.match(d.label, /^[A-Z][^A-Z]*/, d.label);
    }
    assert.equal(new Set(KNOWN_ACTION_DEFS.map((d) => d.action)).size, KNOWN_ACTION_DEFS.length, "no duplicate actions");
  });

  it("Tier 3 money kinds pinned in Phase 14 stay Tier 3", () => {
    for (const k of ["send_invoice", "mark_invoice_paid", "update_campaign_budget", "money_connector_write"]) {
      assert.equal(evaluateTier({ kind: k }, ON), 3, k);
      assert.ok(TIER3_EXACT_KINDS.has(normalizeForTier(k)), k);
    }
  });
});

describe("Phase 14: draft_purchase_order is Tier 0 without weakening any money pattern", () => {
  const OPS_DRAFT_PO_DESC =
    "ops_draft_purchase_order: Create a DRAFT purchase order (free, logged — no approval needed). Sending it later requires human approval. Receiving a sent PO books restock inventory transactions automatically.";

  it("the kind alone and with the chat tool's own description is Tier 0", () => {
    assert.equal(evaluateTier({ kind: "draft_purchase_order" }, ON), 0);
    assert.equal(evaluateTier({ kind: "draft_purchase_order", description: OPS_DRAFT_PO_DESC }, ON), 0);
    assert.equal(evaluateTier({ kind: "draft_purchase_order", description: "draft purchase orders for next week" }, ON), 0);
    const d = decideAutoApproval([auto("draft_purchase_order")], { agentKey: "lead", action: "draft_purchase_order", description: OPS_DRAFT_PO_DESC });
    assert.equal(d.auto, true);
    assert.equal(d.tier, 0);
  });

  it("every other money phrasing stays Tier 3", () => {
    const tier3: Array<[string, string?]> = [
      ["purchase order sent"],
      ["send_purchase_order"],
      ["purchase_order"],
      ["approve purchase order"],
      ["buy_media"],
      ["buy media"],
      ["draft_content", "purchase 500 units"],
      ["draft_purchase_order", "and then purchase the stock"],
      ["draft_purchase_order", "buy the stock now"],
      ["draft_purchase_order", "refund the supplier"],
      ["draft_purchase_order", "transfer $5,000 to the supplier"],
      ["draft_purchase_order", "delete the old purchase orders"],
      ["draft_purchase_orders_and_purchase"],
      ["draft_invoice", "and purchase ads"],
      ["spend_budget"],
      ["issue_refund"],
      ["payout_affiliates"],
      ["withdraw_funds"],
      ["sign_contract"],
      ["delete_campaign_data"],
      ["purge_logs"],
    ];
    for (const [kind, description] of tier3) {
      assert.equal(evaluateTier({ kind, description }, ON), 3, `${kind} / ${description ?? ""}`);
      const d = decideAutoApproval([auto(kind)], { agentKey: "lead", action: kind, description });
      assert.equal(d.auto, false, `${kind} never auto`);
      assert.equal(d.offerAuto, false);
    }
  });
});

describe("Phase 14: amounts and currencies still ask", () => {
  it("an amount over the threshold asks; at or under runs; unknown currency asks", () => {
    const rows = [auto("send_outreach_email", ALL_AGENTS, 5_000)];
    const base = { agentKey: "lead", action: "send_outreach_email" };
    assert.equal(decideAutoApproval(rows, { ...base, amountCents: 5_000 }).auto, true);
    const over = decideAutoApproval(rows, { ...base, amountCents: 5_001 });
    assert.equal(over.auto, false);
    assert.match(over.reason, /over the send_outreach_email threshold/);
    assert.equal(over.offerAuto, true, "still offered — a smaller amount could run");
    assert.equal(decideAutoApproval(rows, { ...base, amountCents: 100, currency: "XYZ" }).auto, false);
    // The workspace default threshold applies when the row has none.
    const ws = [{ agentKey: ALL_AGENTS, action: "*", behavior: "ask" as const, thresholdCents: 2_000 }, auto("publish_owned")];
    assert.equal(decideAutoApproval(ws, { agentKey: "lead", action: "publish_owned", amountCents: 2_500 }).auto, false);
    assert.equal(decideAutoApproval(ws, { agentKey: "lead", action: "publish_owned", amountCents: 1_500 }).auto, true);
  });
});

describe("Phase 14: every chat tool", () => {
  const tools = allTools();

  it("registers the full tool set (sanity)", () => {
    assert.ok(tools.length > 40, `only ${tools.length} tools`);
  });

  it("destructive and Tier-3 tools never run without asking under forced auto rows; the rest can", () => {
    const moneyTools = [
      "ops_send_invoice",
      "ops_mark_invoice_paid",
      "ops_record_payment",
      "ops_post_journal_entry",
      "ops_payroll_request_approval",
      "ops_payroll_request_posting",
      "ops_complete_manufacturing_order",
      "ops_close_pos_session",
    ];
    const seen = new Set<string>();
    for (const t of tools) {
      if (t.kind === "safe") continue;
      const action = toolAction(t.name);
      const description = `${t.name}: ${t.description}`;
      const rows = [auto(action), auto(action, "lead")];
      const d = decideAutoApproval(rows, { agentKey: "lead", action, description, destructive: t.kind === "destructive" });
      const intrinsic = evaluateTier({ kind: action, description }, ON);
      if (t.kind === "destructive" || intrinsic === 3 || NEVER_AUTO_ACTIONS.has(action)) {
        assert.equal(d.auto, false, `${t.name} must always ask`);
        assert.equal(d.offerAuto, false, `${t.name} must never be offered auto`);
      } else {
        assert.equal(d.auto, true, `${t.name} (Tier ${intrinsic}) runs under a rule: ${d.reason}`);
      }
      if (moneyTools.includes(t.name)) {
        assert.equal(d.auto, false, `${t.name} is money`);
        seen.add(t.name);
      }
    }
    assert.deepEqual([...seen].sort(), [...moneyTools].sort(), "every money tool was checked");
  });
});

describe("Phase 14: connector writes", () => {
  it("every built-in connector's mutating tool maps to a catalog action, and money connectors never auto", () => {
    const known = new Set(KNOWN_ACTION_DEFS.map((d) => d.action));
    // Kinds from before Phase 14 with their own mapping that are not catalog rows.
    const legacy = new Set(["delete_social_post"]);
    let writes = 0;
    for (const meta of listBuiltinConnectors()) {
      let adapter;
      try {
        adapter = resolveAdapter(meta.key);
      } catch {
        continue;
      }
      for (const t of adapter.listTools()) {
        if (!t.mutating) continue;
        writes++;
        const action = connectorAction(meta.key, t.name);
        assert.ok(known.has(action) || legacy.has(action), `${meta.key}.${t.name} → ${action} is in the catalog`);
        assert.notEqual(action, "connector_write", `${meta.key}.${t.name} has its own switch`);
        const d = decideAutoApproval([auto(action)], { agentKey: "lead", action, description: `${t.name}: ${t.description}` });
        const intrinsic = evaluateTier({ kind: action, description: `${t.name}: ${t.description}` }, ON);
        assert.equal(d.auto, intrinsic !== 3, `${meta.key}.${t.name}`);
        // On a money connector only a contact import (CRM records, no money) may auto-run.
        if (MONEY_CONNECTOR_KEYS.has(meta.key) && action !== "write_crm_record") {
          assert.equal(d.auto, false, `${meta.key}.${t.name} moves money or the books`);
        }
      }
    }
    assert.ok(writes >= 25, `checked ${writes} connector writes`);
  });

  it("per-connector switches: write_<key>, money connectors fall to a Tier-3 kind", () => {
    assert.equal(connectorAction("slack", "post_message"), "write_slack");
    assert.equal(connectorAction("slack", "reply_in_thread"), "write_slack");
    assert.equal(connectorAction("google-business-profile", "create_post"), "write_google_business_profile");
    assert.equal(connectorAction("outlook-calendar", "create_event"), "write_outlook_calendar");
    // Existing mappings are unchanged.
    assert.equal(connectorAction("wordpress", "save_content"), "publish_owned");
    assert.equal(connectorAction("gmail", "send_email"), "send_outreach_email");
    assert.equal(connectorAction("quickbooks", "post_to_quickbooks"), "post_to_accounting");
    for (const key of MONEY_CONNECTOR_KEYS) {
      const action = connectorAction(key, "some_new_write");
      assert.equal(action, "money_connector_write");
      assert.equal(decideAutoApproval([auto(action)], { agentKey: "lead", action }).auto, false);
      assert.ok(validateBehaviorForAction(action, "auto", undefined));
    }
  });

  it("custom MCP: default mcp_write (Tier 2, auto only with a rule); destructiveHint never auto", () => {
    assert.equal(DEFAULT_MCP_ACTION, "mcp_write");
    assert.equal(mcpToolAction({}, "anything"), "mcp_write");
    assert.equal(new Set(MCP_ASSIGNABLE_ACTIONS).size, MCP_ASSIGNABLE_ACTIONS.length, "no duplicates in the admin list");
    assert.equal(decideAutoApproval([], { agentKey: "lead", action: "mcp_write" }).auto, false);
    assert.equal(decideAutoApproval([auto("mcp_write")], { agentKey: "lead", action: "mcp_write", description: "create_ticket: Open a ticket" }).auto, true);
    // A money word in the tool's description is Tier 3 whatever the action.
    assert.equal(decideAutoApproval([auto("mcp_write")], { agentKey: "lead", action: "mcp_write", description: "create_refund: Refund a charge" }).auto, false);
    const def = mcpToolToDef({ name: "drop_rows", description: "Remove rows", annotations: { destructiveHint: true } });
    assert.equal(def.destructive, true);
    assert.equal(decideAutoApproval([auto("mcp_write")], { agentKey: "lead", action: "mcp_write", destructive: def.destructive }).auto, false);
    assert.equal(mcpToolToDef({ name: "add_row", description: "Add a row" }).destructive, undefined);
    assert.equal(mcpToolToDef({ name: "read", annotations: { readOnlyHint: true, destructiveHint: true } }).destructive, undefined);
  });
});

describe("Phase 14: explicit code defaults", () => {
  it("slack_reply defaults to auto (today's behaviour), slack_placeholder to off — both changeable", () => {
    assert.equal(resolveAutomationFromRows([], "slack_reply").behavior, "auto");
    assert.equal(resolveAutomationFromRows([], "slack_reply").source, "default");
    assert.equal(resolveAutomationFromRows([], "slack_placeholder").behavior, "never");
    const d = decideAutoApproval([], { agentKey: "lead", action: "slack_reply" });
    assert.equal(d.auto, true);
    assert.match(d.reason, /auto-approved by the default for slack_reply/);
    const ask = [{ agentKey: ALL_AGENTS, action: "slack_reply", behavior: "ask" as const, thresholdCents: null }];
    assert.equal(decideAutoApproval(ask, { agentKey: "lead", action: "slack_reply" }).auto, false);
    // Per agent: the lead's own rule wins.
    assert.equal(
      decideAutoApproval([...ask, { agentKey: "lead", action: "slack_reply", behavior: "auto", thresholdCents: null }], { agentKey: "lead", action: "slack_reply" }).auto,
      true,
    );
    assert.equal(KNOWN_ACTIONS.find((a) => a.action === "slack_reply")?.defaultBehavior, "auto");
    assert.equal(KNOWN_ACTIONS.find((a) => a.action === "slack_placeholder")?.defaultBehavior, "never");
    assert.equal(autoAllowedFor("slack_reply"), true);
    // Every other non-Tier-3 action defaults to ask.
    for (const a of KNOWN_ACTIONS) {
      if (a.action in DEFAULT_BEHAVIORS) continue;
      assert.equal(a.defaultBehavior, a.tier === 3 ? "never" : "ask", a.action);
    }
  });
});
