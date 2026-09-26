// Marketr — Phase 9 M1: approval executor pre-flight tests.
// Run: npx tsx --test lib/orchestrator/__tests__/executor.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalError,
  createMemoryMissionApprovalStore,
  executeApproved,
  type ExecuteApprovedDeps,
} from "../../authority/executor";
import { bindingHashOf } from "../../authority/approvals";

const WS = "ws_test_1";

function deps(overrides: Partial<ExecuteApprovedDeps> = {}): ExecuteApprovedDeps {
  return {
    store: createMemoryMissionApprovalStore(),
    isWorkspaceFrozen: async () => false,
    isMissionPaused: async () => false,
    tierSettings: {
      smallActionThresholdCents: 10_000,
      automationAllows: true,
      defaultCurrency: "USD",
      rates: { USD: 1 },
    },
    ...overrides,
  };
}

/** Create an approval and move it to `approved` (the human-signed state). */
async function approvedApproval(d: ExecuteApprovedDeps, action: Record<string, unknown>, tier: number) {
  const a = await d.store.create({
    workspaceId: WS,
    action: (action as { kind: string }).kind,
    tier,
    bindingJson: action,
    createdBy: "user_1",
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return d.store.setStatus(a.id, WS, "approved", { decidedAt: new Date() });
}

describe("executeApproved pre-flight", () => {
  it("happy path: approved + matching binding + Tier 2 -> executed, hash-chained event", async () => {
    const d = deps();
    const action = { kind: "publish_blog", title: "Q4 recap", channel: "blog" };
    const a = await approvedApproval(d, action, 2);
    const res = await executeApproved({ approvalId: a.id, action, workspaceId: WS }, d);
    assert.equal(res.approval.status, "executed");
    assert.equal(res.tier, 2);
    assert.equal(res.event.prevHash, "GENESIS");
    assert.equal(res.event.action, "executed");
    assert.equal(res.event.actor, "executor");
    assert.ok(res.event.eventHash.length === 64);
  });

  it("expired approval -> HALT, status marked expired", async () => {
    const d = deps();
    const action = { kind: "publish_blog", title: "old" };
    const created = await d.store.create({
      workspaceId: WS,
      action: "publish_blog",
      tier: 2,
      bindingJson: action,
      createdBy: "user_1",
      expiresAt: new Date(Date.now() - 1_000), // already expired
    });
    await d.store.setStatus(created.id, WS, "approved", { decidedAt: new Date(Date.now() - 7_200_000) });
    await assert.rejects(
      () => executeApproved({ approvalId: created.id, action, workspaceId: WS }, d),
      (e) => e instanceof ApprovalError && /expired/i.test(e.message),
    );
    const after = await d.store.get(created.id, WS);
    assert.equal(after?.status, "expired");
  });

  it("tampered binding -> HALT, halt event appended", async () => {
    const d = deps();
    const action = { kind: "publish_blog", title: "Q4 recap" };
    const a = await approvedApproval(d, action, 2);
    const tampered = { kind: "publish_blog", title: "Q4 recap EDITED" };
    await assert.rejects(
      () => executeApproved({ approvalId: a.id, action: tampered, workspaceId: WS }, d),
      (e) => e instanceof ApprovalError && /binding mismatch/i.test(e.message),
    );
    const after = await d.store.get(a.id, WS);
    assert.equal(after?.status, "approved"); // stays approved — nothing executed
  });

  it("Tier 3 -> ALWAYS halt, even with a valid approval", async () => {
    const d = deps();
    const action = { kind: "note", description: "tier 0 action: buy $5000 in ads" };
    const a = await approvedApproval(d, action, 2);
    await assert.rejects(
      () => executeApproved({ approvalId: a.id, action, workspaceId: WS }, d),
      (e) => e instanceof ApprovalError && /tier 3/i.test(e.message),
    );
  });

  it("frozen workspace -> HALT first, before anything else", async () => {
    const d = deps({ isWorkspaceFrozen: async () => true });
    const action = { kind: "publish_blog", title: "Q4 recap" };
    const a = await approvedApproval(d, action, 2);
    await assert.rejects(
      () => executeApproved({ approvalId: a.id, action, workspaceId: WS }, d),
      (e) => e instanceof ApprovalError && /frozen/i.test(e.message),
    );
  });

  it("paused mission -> HALT", async () => {
    const d = deps({ isMissionPaused: async () => true });
    const action = { kind: "publish_blog", title: "Q4 recap" };
    const created = await d.store.create({
      workspaceId: WS,
      missionId: "mission_1",
      action: "publish_blog",
      tier: 2,
      bindingJson: action,
      createdBy: "user_1",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await d.store.setStatus(created.id, WS, "approved", { decidedAt: new Date() });
    await assert.rejects(
      () => executeApproved({ approvalId: created.id, action, workspaceId: WS }, d),
      (e) => e instanceof ApprovalError && /paused/i.test(e.message),
    );
  });

  it("non-approved status (pending) -> HALT", async () => {
    const d = deps();
    const action = { kind: "publish_blog", title: "Q4 recap" };
    const a = await d.store.create({
      workspaceId: WS,
      action: "publish_blog",
      tier: 2,
      bindingJson: action,
      createdBy: "user_1",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await assert.rejects(
      () => executeApproved({ approvalId: a.id, action, workspaceId: WS }, d),
      (e) => e instanceof ApprovalError && /pending/.test(e.message),
    );
  });

  it("revoked approval -> HALT", async () => {
    const d = deps();
    const action = { kind: "publish_blog", title: "Q4 recap" };
    const a = await approvedApproval(d, action, 2);
    await d.store.setStatus(a.id, WS, "revoked");
    await assert.rejects(
      () => executeApproved({ approvalId: a.id, action, workspaceId: WS }, d),
      (e) => e instanceof ApprovalError && /revoked/.test(e.message),
    );
  });

  it("tier escalation since approval -> HALT", async () => {
    // Approved at Tier 1 with the toggle ON; toggle turned OFF before
    // execution -> action re-evaluates to Tier 2 > approved Tier 1.
    const d = deps({ tierSettings: { smallActionThresholdCents: 10_000, automationAllows: false } });
    const action = { kind: "publish_owned", amountCents: 5000, currency: "USD" };
    const a = await approvedApproval(d, action, 1);
    await assert.rejects(
      () => executeApproved({ approvalId: a.id, action, workspaceId: WS }, d),
      (e) => e instanceof ApprovalError && /escalated/i.test(e.message),
    );
  });

  it("unknown approval id -> HALT", async () => {
    const d = deps();
    await assert.rejects(
      () =>
        executeApproved(
          { approvalId: "mx_nope", action: { kind: "publish_blog" }, workspaceId: WS },
          d,
        ),
      (e) => e instanceof ApprovalError && /not found/i.test(e.message),
    );
  });

  it("event chain is verifiable: second event links to first", async () => {
    const d = deps();
    const action = { kind: "publish_blog", title: "Q4 recap" };
    const a = await approvedApproval(d, action, 2);
    const ev1 = await d.store.appendEvent(a.id, WS, "user_1", "note", { x: 1 });
    const ev2 = await d.store.appendEvent(a.id, WS, "user_1", "note", { x: 2 });
    assert.equal(ev2.prevHash, ev1.eventHash);
    assert.notEqual(ev1.eventHash, ev2.eventHash);
    // binding hash determinism: canonicalization is key-order independent
    assert.equal(
      bindingHashOf({ b: 1, a: 2 }),
      bindingHashOf({ a: 2, b: 1 }),
    );
  });
});
