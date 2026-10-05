// ShapesOS — Phase 14 (approvals): the other gates honour automation rules.
//   - ops gate: only automatable (no-money) slugs may be approved by a rule;
//     money slugs never, whatever the rule says;
//   - Composio: a "composio:<toolkit>" rule covers classified MEDIUM writes
//     only; high (destructive) and money-named tools always ask;
//   - missions: a rule approves a drafter's request (audited) and the
//     executor resolves its tier settings from the rules.
// Run: npx tsx --test lib/automation/__tests__/p14-gates.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OPS_AUTOMATABLE_SLUGS,
  OPS_MONEY_ACTIONS,
  requestOpsApproval,
  type OpsGatePort,
} from "@/lib/ops/gate";
import { composioAction, composioAutoInput } from "@/lib/integrations/actions/agent";
import { classifyAction } from "@/lib/integrations/actions/risk";
import {
  ApprovalError,
  autoApproveMissionApproval,
  createMemoryMissionApprovalStore,
  executeApproved,
} from "@/lib/authority/executor";
import {
  ALL_AGENTS,
  KNOWN_ACTIONS,
  decideAutoApproval,
  resolveAutomationFromRows,
  toTierSettings,
  type AutomationRowLike,
} from "../policy";
import { AUTOPILOT_KIND_ACTION } from "../actions";
import { runDrafter } from "@/lib/orchestrator/executors/drafter";

const auto = (action: string, agentKey = ALL_AGENTS): AutomationRowLike => ({ agentKey, action, behavior: "auto", thresholdCents: null });

function stubPort(decide: (action: string) => boolean) {
  const proposals: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const port: OpsGatePort = {
    async propose(input) {
      proposals.push(input);
      return input.autoApprovedReason
        ? { id: `ap_${proposals.length}`, status: "approved", riskTier: "medium", autoApproved: input.autoApprovedReason }
        : { id: `ap_${proposals.length}`, status: "pending", riskTier: "medium" };
    },
    async autoDecision(_ws, input) {
      asked.push(input.action);
      return decide(input.action) ? { auto: true, reason: `auto-approved by the ${input.action} rule for every agent` } : { auto: false, reason: "no rule" };
    },
    async getApproval() {
      throw new Error("not used");
    },
  };
  return { port, proposals, asked };
}

const req = (slug: string) => ({ workspaceId: "ws", slug, entity: "x", mutation: { id: "1" }, actor: "user-1", summary: slug });

describe("Phase 14: ops gate automatable flag", () => {
  it("only OPS_MO_CONFIRM and OPS_TWIN_SITE_PUBLISH are automatable; their actions are switchable catalog rows", () => {
    assert.deepEqual([...OPS_AUTOMATABLE_SLUGS].sort(), ["OPS_MO_CONFIRM", "OPS_TWIN_SITE_PUBLISH"]);
    for (const a of OPS_MONEY_ACTIONS.filter((x) => x.automatable)) {
      const k = KNOWN_ACTIONS.find((x) => x.action === a.action);
      assert.ok(k, `${a.slug} → ${a.action} is a catalog row`);
      assert.equal(k!.autoAllowed, true);
      assert.notEqual(k!.tier, 3);
    }
  });

  it("an automatable slug with an auto rule is stored approved, naming the rule", async () => {
    const { port, proposals } = stubPort(() => true);
    const twin = await requestOpsApproval(port, req("OPS_TWIN_SITE_PUBLISH"));
    assert.equal(twin.status, "approved");
    assert.match(twin.autoApproved ?? "", /publish_site_layout rule/);
    assert.match(String(proposals[0]!.autoApprovedReason), /publish_site_layout/);
    const mo = await requestOpsApproval(port, req("OPS_MO_CONFIRM"));
    assert.equal(mo.status, "approved");
  });

  it("without a rule it waits for a person", async () => {
    const { port } = stubPort(() => false);
    const twin = await requestOpsApproval(port, req("OPS_TWIN_SITE_PUBLISH"));
    assert.equal(twin.status, "pending");
    assert.equal(twin.autoApproved, undefined);
  });

  it("money slugs never auto-approve — the rule is not even consulted", async () => {
    const { port, proposals, asked } = stubPort(() => true);
    for (const a of OPS_MONEY_ACTIONS.filter((x) => !x.automatable)) {
      const p = await requestOpsApproval(port, req(a.slug));
      assert.equal(p.status, "pending", a.slug);
    }
    assert.deepEqual(asked, []);
    assert.ok(proposals.every((p) => p.autoApprovedReason === undefined));
    // The money slugs the owner named stay out.
    for (const s of ["OPS_INVOICE_SEND", "OPS_PAYMENT_REFUND", "OPS_BILL_PAY", "OPS_PAYROLL_APPROVE", "OPS_MO_COMPLETE", "OPS_SCRAP_POST", "OPS_ORDER_FULFILL"]) {
      assert.ok(!OPS_AUTOMATABLE_SLUGS.has(s), s);
    }
  });

  it("a stub port without autoDecision always asks (fail closed)", async () => {
    const port: OpsGatePort = {
      async propose(input) {
        return { id: "x", status: input.autoApprovedReason ? "approved" : "pending", riskTier: "medium" };
      },
      async getApproval() {
        throw new Error("not used");
      },
    };
    assert.equal((await requestOpsApproval(port, req("OPS_TWIN_SITE_PUBLISH"))).status, "pending");
  });
});

describe("Phase 14: Composio medium writes honour composio:<toolkit>", () => {
  it("only a classified medium write of a known toolkit can be covered", () => {
    const medium = classifyAction("GMAIL_SEND_EMAIL");
    assert.equal(medium.tier, "medium");
    assert.deepEqual(composioAutoInput(medium, "gmail", "GMAIL_SEND_EMAIL", "actor"), {
      agentKey: "actor",
      action: "composio:gmail",
      description: "gmail send email",
    });
    assert.equal(composioAutoInput(medium, null, "GMAIL_SEND_EMAIL"), null, "no toolkit → no rule");
    const high = classifyAction("GMAIL_DELETE_MESSAGE");
    assert.equal(high.tier, "high");
    assert.equal(composioAutoInput(high, "gmail", "GMAIL_DELETE_MESSAGE"), null, "high always asks");
    const low = classifyAction("GMAIL_LIST_MESSAGES");
    assert.equal(composioAutoInput(low, "gmail", "GMAIL_LIST_MESSAGES"), null, "reads already run");
    assert.equal(composioAutoInput({ tier: "medium", classified: false, autoExecutable: false }, "gmail", "X"), null, "unclassified always asks");
  });

  it("a rule lets a medium write run; a money-named tool never, whatever the rule", () => {
    const rows = [auto("composio:gmail"), auto("composio:stripe"), auto("composio:quickbooks")];
    const send = composioAutoInput(classifyAction("GMAIL_SEND_EMAIL"), "gmail", "GMAIL_SEND_EMAIL")!;
    assert.equal(decideAutoApproval(rows, send).auto, true);
    assert.equal(decideAutoApproval([], send).auto, false, "no rule → asks");
    for (const tool of ["STRIPE_CREATE_REFUND", "STRIPE_CREATE_PAYOUT", "STRIPE_CREATE_TRANSFER", "QUICKBOOKS_CREATE_PURCHASE"]) {
      const c = classifyAction(tool);
      const input = composioAutoInput(c, tool.split("_")[0]!.toLowerCase(), tool);
      if (!input) continue; // high / unclassified — asks anyway
      const d = decideAutoApproval(rows, input);
      assert.equal(d.auto, false, `${tool} is money`);
      assert.equal(d.tier, 3);
    }
    assert.equal(composioAction("slack"), "composio:slack");
  });

  it("payments / accounting toolkits and money-named tools never get a rule", () => {
    const m = (tool: string) => classifyAction(tool);
    assert.equal(composioAutoInput(m("STRIPE_CREATE_CUSTOMER"), "stripe", "STRIPE_CREATE_CUSTOMER"), null, "a payments toolkit");
    assert.equal(composioAutoInput(m("QUICKBOOKS_CREATE_CUSTOMER"), "quickbooks", "QUICKBOOKS_CREATE_CUSTOMER"), null);
    for (const tool of ["HUBSPOT_CREATE_INVOICE", "SALESFORCE_CREATE_ORDER", "NOTION_CREATE_PAYMENT_PAGE", "SLACK_SEND_PAY_LINK", "ZENDESK_UPDATE_SUBSCRIPTION"]) {
      const c = m(tool);
      if (c.tier !== "medium") continue;
      assert.equal(composioAutoInput(c, tool.split("_")[0]!.toLowerCase(), tool), null, `${tool} names money`);
    }
    const contact = composioAutoInput(m("HUBSPOT_CREATE_CONTACT"), "hubspot", "HUBSPOT_CREATE_CONTACT");
    assert.ok(contact, "a CRM contact write can be covered");
    assert.equal(decideAutoApproval([auto("composio:hubspot", "actor")], { ...contact!, agentKey: "actor" }).auto, true);
  });
});

describe("Phase 14: missions honour a rule", () => {
  const WS = "ws-m";
  const deps = (rows: AutomationRowLike[], agentKey = ALL_AGENTS) => ({
    isWorkspaceFrozen: () => false,
    isMissionPaused: () => false,
    resolveTierSettings: (action: { kind: string }) => toTierSettings(resolveAutomationFromRows(rows, action.kind, agentKey)),
  });

  const guards = { isWorkspaceFrozen: () => false, isMissionPaused: () => false };
  it("the drafter's request is approved by a rule (audited); without one it waits", async () => {
    const store = createMemoryMissionApprovalStore();
    const withRule = await runDrafter(
      { workspaceId: WS, missionId: "m1", brief: "Launch post.", artifactKind: "content", channel: "blog" },
      { ...guards, approvalStore: store, autoDecision: async (q) => decideAutoApproval([auto(q.action, "drafter")], { agentKey: "drafter", action: q.action, description: q.description }) },
    );
    assert.equal(withRule.approval.status, "approved");
    assert.match(withRule.summary, /approved by an automation rule \(auto-approved by the publish_content rule for agent drafter\)/);
    const without = await runDrafter(
      { workspaceId: WS, missionId: "m1", brief: "Launch post.", artifactKind: "content", channel: "blog" },
      { ...guards, approvalStore: store, autoDecision: async (q) => decideAutoApproval([], { agentKey: "drafter", action: q.action, description: q.description }) },
    );
    assert.equal(without.approval.status, "pending");
    // No mission → can't be chain-logged → a person decides.
    const noMission = await runDrafter(
      { workspaceId: WS, brief: "Launch post.", artifactKind: "content" },
      { ...guards, approvalStore: store, autoDecision: async () => ({ auto: true, tier: 2, reason: "rule" }) },
    );
    assert.equal(noMission.approval.status, "pending");
  });

  it("a Tier-3 or non-auto decision never approves", async () => {
    const store = createMemoryMissionApprovalStore();
    const a = await store.create({ workspaceId: WS, missionId: "m1", action: "buy_media", tier: 3, bindingJson: { kind: "buy_media" }, createdBy: "x" });
    assert.equal((await autoApproveMissionApproval(store, a, { auto: true, tier: 3, reason: "forced" })).status, "pending");
    assert.equal((await autoApproveMissionApproval(store, a, { auto: false, tier: 2, reason: "no" })).status, "pending");
    assert.equal((await autoApproveMissionApproval(store, a, null)).status, "pending");
  });

  it("the executor resolves tier settings from the rules: a rule-approved Tier-1 action runs, and halts once the rule is off", async () => {
    const store = createMemoryMissionApprovalStore();
    const action = { kind: "publish_owned", channel: "blog" };
    const rows = [auto("publish_owned")];
    const d = decideAutoApproval(rows, { agentKey: ALL_AGENTS, action: "publish_owned" });
    assert.equal(d.tier, 1);
    const created = await store.create({ workspaceId: WS, missionId: "m1", action: "publish_owned", tier: d.tier, bindingJson: action, createdBy: "x" });
    const approved = await autoApproveMissionApproval(store, created, d);
    assert.equal(approved.status, "approved");
    const ok = await executeApproved({ approvalId: approved.id, action, workspaceId: WS }, { store, ...deps(rows) });
    assert.equal(ok.tier, 1);

    // The same kind of approval once the rule is switched off: Tier 2 now > approved Tier 1 → HALT.
    const again = await autoApproveMissionApproval(
      store,
      await store.create({ workspaceId: WS, missionId: "m1", action: "publish_owned", tier: 1, bindingJson: action, createdBy: "x" }),
      d,
    );
    await assert.rejects(executeApproved({ approvalId: again.id, action, workspaceId: WS }, { store, ...deps([]) }), ApprovalError);

    // Tier 3 halts whatever the rules say.
    const money = { kind: "buy_media" };
    const m = await store.create({ workspaceId: WS, missionId: "m1", action: "buy_media", tier: 3, bindingJson: money, createdBy: "x" });
    await store.setStatus(m.id, WS, "approved");
    await assert.rejects(executeApproved({ approvalId: m.id, action: money, workspaceId: WS }, { store, ...deps([auto("buy_media")]) }), /Tier 3/);
  });
});

describe("Phase 14: autopilot kinds map to switchable actions", () => {
  it("every item kind's action is a non-Tier-3 catalog row", () => {
    for (const [kind, action] of Object.entries(AUTOPILOT_KIND_ACTION)) {
      const k = KNOWN_ACTIONS.find((a) => a.action === action);
      assert.ok(k && k.autoAllowed, `${kind} → ${action}`);
    }
  });
});
