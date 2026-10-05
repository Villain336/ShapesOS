// ShapesOS — Phase 14 (approvals): missions read the automation rules from
// Postgres (as the app role).
//   - the drafter's request is approved by the drafter's rule in
//     automation_settings (audited), and waits without one;
//   - the mission executor resolves its tier settings from those rows
//     (automationTierSettingsFor): a rule-approved Tier-1 action executes,
//     halts once the rule is switched off, and Tier 3 halts whatever a
//     forced row says.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/automation/__tests__/p14-approvals-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { autoApprovalFor, automationTierSettingsFor } from "../policy";
import { ApprovalError, autoApproveMissionApproval, createMemoryMissionApprovalStore, executeApproved } from "@/lib/authority/executor";
import { runDrafter } from "@/lib/orchestrator/executors/drafter";

const WS = `p14ap-${Date.now().toString(36)}`;
const USER = `${WS}-user`;
const guards = { isWorkspaceFrozen: () => false, isMissionPaused: () => false };
const setRule = (agentKey: string, action: string, behavior: "auto" | "ask" | "never") =>
  withWorkspaceScope(WS, (tx) =>
    tx.automationSetting.upsert({
      where: { workspaceId_agentKey_action: { workspaceId: WS, agentKey, action } },
      create: { workspaceId: WS, agentKey, action, behavior, updatedBy: USER },
      update: { behavior },
    }),
  );

before(async () => {
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: USER } });
});
after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("Phase 14: missions honour the automation rules in Postgres", () => {
  it("the drafter's Tier-2 request waits without a rule and is rule-approved with one", async () => {
    const store = createMemoryMissionApprovalStore();
    const input = { workspaceId: WS, missionId: "m-1", brief: "Announce the launch.", artifactKind: "content" as const, channel: "blog" };
    const waits = await runDrafter(input, { ...guards, approvalStore: store });
    assert.equal(waits.approval.status, "pending");
    await setRule("drafter", "publish_content", "auto");
    const approved = await runDrafter(input, { ...guards, approvalStore: store });
    assert.equal(approved.approval.status, "approved");
    assert.match(approved.summary, /auto-approved by the publish_content rule for agent drafter/);
    // Another agent's rule does not cover the drafter… and the lead's ask doesn't override it.
    await setRule("lead", "publish_content", "ask");
    assert.equal((await runDrafter(input, { ...guards, approvalStore: store })).approval.status, "approved");
  });

  it("the executor's tier settings come from the rows: Tier 1 runs under the rule, halts once it is off; Tier 3 always halts", async () => {
    const store = createMemoryMissionApprovalStore();
    const action = { kind: "publish_owned", channel: "blog" };
    await setRule("actor", "publish_owned", "auto");
    const decision = await autoApprovalFor(WS, { agentKey: "actor", action: "publish_owned" });
    assert.equal(decision.auto, true);
    assert.equal(decision.tier, 1);
    const a = await autoApproveMissionApproval(
      store,
      await store.create({ workspaceId: WS, missionId: "m-2", action: "publish_owned", tier: decision.tier, bindingJson: action, createdBy: "actor" }),
      decision,
    );
    const deps = { store, ...guards, resolveTierSettings: automationTierSettingsFor(WS, "actor") };
    const ok = await executeApproved({ approvalId: a.id, action, workspaceId: WS }, deps);
    assert.equal(ok.tier, 1);

    const b = await autoApproveMissionApproval(
      store,
      await store.create({ workspaceId: WS, missionId: "m-2", action: "publish_owned", tier: 1, bindingJson: action, createdBy: "actor" }),
      decision,
    );
    await setRule("actor", "publish_owned", "ask");
    await assert.rejects(executeApproved({ approvalId: b.id, action, workspaceId: WS }, deps), ApprovalError);

    await setRule("*", "buy_media", "auto"); // forced (the PUT guard would refuse it)
    const money = { kind: "buy_media" };
    const m = await store.create({ workspaceId: WS, missionId: "m-2", action: "buy_media", tier: 3, bindingJson: money, createdBy: "actor" });
    assert.equal((await autoApproveMissionApproval(store, m, await autoApprovalFor(WS, { agentKey: "actor", action: "buy_media" }))).status, "pending");
    await store.setStatus(m.id, WS, "approved");
    await assert.rejects(executeApproved({ approvalId: m.id, action: money, workspaceId: WS }, deps), /Tier 3/);
  });
});
