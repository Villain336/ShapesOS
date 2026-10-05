// ShapesOS — Phase 3: hosted trial plan, end to end against the database.
//   - plan assignment by DEPLOYMENT_MODE (one trial per person)
//   - a running trial is hard-capped at its pool (no overage, even if opted in)
//   - an ended trial refuses every metered charge with an upgrade prompt;
//     free actions still pass; picking a paid plan unblocks
//   - the trial pool doesn't refill at a month boundary
//   - a lapsed subscription on a hosted deployment lands on an ended trial
// Run (DB suite): DATABASE_URL=… npx tsx --test lib/metering/__tests__/trial-db.test.ts

import "dotenv/config";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { applyPlanChange, checkCap, meter } from "../service";
import { createWorkspaceForUser } from "@/lib/workspace/lifecycle";

const RUN = randomUUID().slice(0, 8);
const HOSTED = { DEPLOYMENT_MODE: "hosted" } as unknown as NodeJS.ProcessEnv;
const SELF = {} as NodeJS.ProcessEnv;
const users: string[] = [];
const user = (tag: string) => {
  const id = `p3-trial-${tag}-${RUN}`;
  users.push(id);
  return id;
};

const charge = (workspaceId: string, credits: number, action = "rank_check") =>
  meter({ workspaceId, action, idempotencyKey: `p3-trial-${randomUUID()}`, credits });

after(async () => {
  // Deleting the workspaces cascades their (otherwise append-only) ledger rows.
  await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
  await prisma.workspaceLifecycleEvent.deleteMany({ where: { actorUserId: { in: users } } });
  await prisma.$disconnect();
});

describe("plan assignment by DEPLOYMENT_MODE", () => {
  it("self-hosted signups get self_hosted, no trial", async () => {
    const ws = await createWorkspaceForUser({ userId: user("self"), name: "Self", env: SELF });
    assert.equal(ws.plan, "self_hosted");
    assert.equal(ws.trialEndsAt, null);
    assert.equal(ws.onboardingCompletedAt, null, "a brand-new workspace starts the onboarding wizard");
    const owner = await prisma.workspaceMember.findFirst({ where: { workspaceId: ws.id } });
    assert.equal(owner?.role, "owner");
  });

  it("a hosted signup gets a 14-day trial; the same person's next workspace does not", async () => {
    const u = user("hosted");
    const now = new Date();
    const first = await createWorkspaceForUser({ userId: u, name: "First", env: HOSTED, now });
    assert.equal(first.plan, "trial");
    assert.equal(first.trialEndsAt?.getTime(), now.getTime() + 14 * 86_400_000);
    const ev = await prisma.workspaceLifecycleEvent.findFirst({ where: { workspaceId: first.id, action: "created" } });
    assert.equal((ev?.detail as { trial?: boolean }).trial, true);

    const second = await createWorkspaceForUser({ userId: u, name: "Second", env: HOSTED });
    assert.equal(second.plan, "trial");
    assert.ok(second.trialEndsAt && second.trialEndsAt.getTime() <= Date.now(), "second trial starts already ended");

    // Deleting the trial workspace doesn't hand out a new trial either.
    await prisma.workspace.delete({ where: { id: first.id } });
    const third = await createWorkspaceForUser({ userId: u, name: "Third", env: HOSTED });
    assert.ok(third.trialEndsAt && third.trialEndsAt.getTime() <= Date.now());
  });

  it("signup provisioning never creates a second workspace for someone who has one", async () => {
    const u = user("race");
    const [a, b] = await Promise.all([
      createWorkspaceForUser({ userId: u, name: "A", env: HOSTED, ifNoneExists: true }),
      createWorkspaceForUser({ userId: u, name: "B", env: HOSTED, ifNoneExists: true }),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(await prisma.workspace.count({ where: { ownerUserId: u } }), 1);
  });
});

describe("trial metering", () => {
  it("hard-caps a running trial at its 500-credit pool, even with auto-overage on", async () => {
    const ws = await createWorkspaceForUser({ userId: user("cap"), name: "Cap", env: HOSTED });
    assert.equal((await charge(ws.id, 400)).ok, true);
    await prisma.spendCap.update({ where: { workspaceId: ws.id }, data: { autoOverage: true, blockAtCap: false } });
    const over = await charge(ws.id, 200);
    assert.equal(over.ok, false);
    assert.equal(!over.ok && over.reason, "cap_exceeded");
    assert.match(!over.ok ? over.message : "", /Trial credits used up/);
    assert.equal((await charge(ws.id, 100)).ok, true, "exactly up to the pool still passes");
    const bal = await prisma.creditBalance.findUnique({ where: { workspaceId: ws.id } });
    assert.equal(bal?.includedCredits, 500);
    assert.equal(bal?.usedCredits, 500);
    const events = await prisma.usageEvent.findMany({ where: { workspaceId: ws.id } });
    assert.equal(events.reduce((n, e) => n + e.overageCredits, 0), 0, "a trial never accrues billable overage");
  });

  it("an ended trial is read-only for metered actions until a plan is chosen", async () => {
    const ws = await createWorkspaceForUser({ userId: user("expired"), name: "Expired", env: HOSTED });
    assert.equal((await charge(ws.id, 5)).ok, true);
    await prisma.workspace.update({ where: { id: ws.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });

    const refused = await charge(ws.id, 1);
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "cap_exceeded", "existing callers keep blocking on cap_exceeded");
    assert.equal(!refused.ok && refused.trialExpired, true);
    assert.match(!refused.ok ? refused.message : "", /trial ended/);
    assert.match(!refused.ok ? refused.message : "", /\/dashboard\/billing/);

    const free = await meter({ workspaceId: ws.id, action: "publish", idempotencyKey: `p3-trial-${randomUUID()}` });
    assert.equal(free.ok, true, "free actions still run on an ended trial");

    let cap = await checkCap(ws.id);
    assert.equal(cap.allowed, false);
    assert.equal(cap.trialExpired, true);

    await applyPlanChange(ws.id, "starter");
    cap = await checkCap(ws.id);
    assert.equal(cap.trialExpired, false);
    assert.equal(cap.allowed, true);
    assert.equal((await charge(ws.id, 1)).ok, true, "a paid plan unblocks");
  });

  it("the trial pool does not refill at a month boundary", async () => {
    const ws = await createWorkspaceForUser({ userId: user("rollover"), name: "Rollover", env: HOSTED });
    assert.equal((await charge(ws.id, 300)).ok, true);
    await prisma.creditBalance.update({
      where: { workspaceId: ws.id },
      data: { periodStart: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1) },
    });
    assert.equal((await charge(ws.id, 100)).ok, true);
    const bal = await prisma.creditBalance.findUnique({ where: { workspaceId: ws.id } });
    assert.equal(bal?.usedCredits, 400, "used credits carried across the rollover");
    assert.equal((await charge(ws.id, 200)).ok, false);
  });

  it("a lapsed subscription lands on an ended trial, never a fresh one", async () => {
    const ws = await createWorkspaceForUser({ userId: user("lapse"), name: "Lapse", env: HOSTED });
    await applyPlanChange(ws.id, "pro");
    await applyPlanChange(ws.id, "trial");
    const after = await prisma.workspace.findUnique({ where: { id: ws.id } });
    assert.equal(after?.plan, "trial");
    assert.ok(after?.trialEndsAt && after.trialEndsAt.getTime() <= Date.now());
    const r = await charge(ws.id, 1);
    assert.equal(!r.ok && r.trialExpired, true);
    const cap = await prisma.spendCap.findUnique({ where: { workspaceId: ws.id } });
    assert.equal(cap?.blockAtCap, true);
  });
});
