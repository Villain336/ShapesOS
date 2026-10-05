// ShapesOS — Phase 2 (H11 billing holes) on real Postgres:
//   - a plan change re-syncs includedCredits AND capCredits in one locked
//     transaction (upgrade lifts the cap; downgrade lowers it; concurrent
//     plan changes / meter() calls leave a consistent pool + cap)
//   - expiring top-up credits lower the cap, so they can't be spent unpaid
//   - the Context.dev daily budget reserve is one conditional UPDATE — no
//     overshoot under Promise.all, no first-of-day create race
// Run (DB suite): DATABASE_URL=… npx tsx --test lib/metering/__tests__/credits-integrity-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { applyPlanChange, applyTopUp, meter } from "../service";
import { includedCreditsForPlan } from "../credits";
import { checkAndReserve, getDailyBudget, setDailyCap, todayKey } from "@/lib/knowledge/contextdev/budget-store";
import { DEFAULT_DAILY_CAP_CREDITS } from "@/lib/knowledge/contextdev/budgets";

// usage_events is append-only (a trigger refuses DELETE, T5), so metered
// workspaces can't be cascade-deleted: ids are unique per run instead.
const RUN = randomUUID().slice(0, 8);
const WS_PLAN = `p2e-meter-plan-${RUN}`;
const WS_EXP = `p2e-meter-expiry-${RUN}`;
const WS_RACE = `p2e-meter-race-${RUN}`;
const WS_CD = `p2e-ctxdev-budget-${RUN}`;

async function createWorkspace(id: string, plan: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspaces (id, name, owner_user_id, plan, updated_at)
     VALUES ($1, $1, $2, $3::"Plan", now()) ON CONFLICT (id) DO UPDATE SET plan = EXCLUDED.plan`,
    id,
    `test:${id}`,
    plan,
  );
}

async function state(workspaceId: string) {
  const [bal, cap, ws] = await Promise.all([
    prisma.creditBalance.findUnique({ where: { workspaceId } }),
    prisma.spendCap.findUnique({ where: { workspaceId } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } }),
  ]);
  return { bal, cap, plan: ws?.plan };
}

const charge = (workspaceId: string, credits: number) =>
  meter({ workspaceId, action: "rank_check", idempotencyKey: `p2e-${randomUUID()}`, credits });

before(async () => {
  await createWorkspace(WS_PLAN, "starter");
  await createWorkspace(WS_EXP, "starter");
  await createWorkspace(WS_RACE, "starter");
  await createWorkspace(WS_CD, "starter");
});

after(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS_CD}`;
  await prisma.$disconnect();
});

describe("plan change re-syncs the credit pool and cap", () => {
  it("upgrade starter → agency lifts the pool and the cap; downgrade lowers both", async () => {
    // Exhaust the starter pool (balance + cap rows created from starter).
    assert.equal((await charge(WS_PLAN, 2500)).ok, true);
    const blocked = await charge(WS_PLAN, 10);
    assert.equal(blocked.ok, false);
    assert.equal((blocked as { reason?: string }).reason, "cap_exceeded");

    const up = await applyPlanChange(WS_PLAN, "agency");
    assert.equal(up.includedCredits, includedCreditsForPlan("agency"));
    assert.equal(up.capCredits, includedCreditsForPlan("agency"));
    const s = await state(WS_PLAN);
    assert.equal(s.plan, "agency");
    assert.equal(s.bal?.includedCredits, 30000);
    assert.equal(s.cap?.capCredits, 30000);
    assert.equal((await charge(WS_PLAN, 10)).ok, true, "upgraded workspace can spend");

    const down = await applyPlanChange(WS_PLAN, "starter");
    assert.equal(down.includedCredits, 2500);
    assert.equal(down.capCredits, 2500);
    assert.equal((await charge(WS_PLAN, 10)).ok, false, "downgrade no longer keeps 30,000/month");
  });

  it("keeps an admin's headroom: cap moves by the pool delta", async () => {
    await prisma.spendCap.update({ where: { workspaceId: WS_PLAN }, data: { capCredits: 3000 } }); // pool 2500 + 500
    const r = await applyPlanChange(WS_PLAN, "pro");
    assert.equal(r.includedCredits, 10000);
    assert.equal(r.capCredits, 10500);
  });

  it("concurrent plan changes + charges leave pool and cap consistent with the final plan", async () => {
    assert.equal((await charge(WS_RACE, 1)).ok, true); // rows from starter: pool 2500, cap 2500
    const plans = ["agency", "pro", "starter", "agency", "pro"] as const;
    await Promise.all([
      ...plans.map((p) => applyPlanChange(WS_RACE, p)),
      ...Array.from({ length: 5 }, () => charge(WS_RACE, 1)),
    ]);
    const s = await state(WS_RACE);
    const pool = includedCreditsForPlan(String(s.plan));
    assert.equal(s.bal?.includedCredits, pool, "pool matches the plan that won");
    assert.equal(s.cap?.capCredits, pool, "cap moved by every delta exactly once");
  });
});

describe("expired top-ups lower the cap", () => {
  it("5,000 expired purchased credits are not spendable after rollover", async () => {
    assert.equal((await charge(WS_EXP, 1)).ok, true); // rows from starter
    await applyTopUp(WS_EXP, { creditsAdded: 5000, expiresAt: new Date(Date.now() + 86_400_000) });
    assert.equal((await state(WS_EXP)).cap?.capCredits, 7500);
    // Rewind: the top-up expired yesterday and the period is last month's.
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1, 1);
    lastMonth.setHours(0, 0, 0, 0);
    await prisma.creditBalance.update({
      where: { workspaceId: WS_EXP },
      data: { purchasedExpiresAt: new Date(Date.now() - 86_400_000), periodStart: lastMonth, usedCredits: 7000 },
    });
    const r = await charge(WS_EXP, 7000);
    assert.equal(r.ok, false, "expired credits must not be spendable");
    assert.equal((r as { reason?: string }).reason, "cap_exceeded");
    const s = await state(WS_EXP);
    assert.equal(s.bal?.purchasedCredits, 0);
    assert.equal(s.cap?.capCredits, 2500, "cap back to the paid pool");
    assert.equal((await charge(WS_EXP, 2500)).ok, true, "the included pool is still spendable");
  });
});

describe("Context.dev daily budget reserve is atomic", () => {
  it("20 concurrent first-of-day reserves of 10 against a 100 cap: exactly 10 allowed, no error", async () => {
    await prisma.contextDevBudget.deleteMany({ where: { workspaceId: WS_CD } });
    const rs = await Promise.all(Array.from({ length: 20 }, () => checkAndReserve(WS_CD, 10)));
    assert.equal(rs.filter((r) => r.decision === "allow").length, 10);
    assert.equal(rs.filter((r) => r.decision === "needs_approval").length, 10);
    const row = await prisma.contextDevBudget.findUnique({
      where: { workspaceId_day: { workspaceId: WS_CD, day: todayKey() } },
    });
    assert.equal(row?.creditsUsed, 100, "never overshoots the cap");
  });

  it("honours a raised cap and refuses bad costs without charging", async () => {
    await setDailyCap(WS_CD, 105);
    assert.equal((await checkAndReserve(WS_CD, 5)).decision, "allow");
    assert.equal((await checkAndReserve(WS_CD, 1)).decision, "needs_approval");
    for (const bad of [-1, Number.NaN, 1.5]) {
      assert.equal((await checkAndReserve(WS_CD, bad)).decision, "needs_approval");
    }
    await setDailyCap(WS_CD, 0);
    assert.equal((await checkAndReserve(WS_CD, 0)).decision, "needs_approval", "cap 0 = no budget");
    const row = await prisma.contextDevBudget.findUnique({
      where: { workspaceId_day: { workspaceId: WS_CD, day: todayKey() } },
    });
    assert.equal(row?.creditsUsed, 105);
  });

  // Phase 4a follow-up: a configured cap used to reset to the default (100)
  // on every new UTC day. A new day now starts from the latest earlier cap.
  it("a configured cap carries forward to later days (even across gaps)", async () => {
    await prisma.contextDevBudget.deleteMany({ where: { workspaceId: WS_CD } });
    const threeDaysAgo = todayKey(new Date(Date.now() - 3 * 86_400_000));
    const weekAgo = todayKey(new Date(Date.now() - 7 * 86_400_000));
    await prisma.contextDevBudget.createMany({
      data: [
        { workspaceId: WS_CD, day: weekAgo, creditsUsed: 0, capCredits: 40 },
        { workspaceId: WS_CD, day: threeDaysAgo, creditsUsed: 300, capCredits: 400 },
      ],
    });
    assert.equal((await getDailyBudget(WS_CD)).capCredits, 400, "a missing row reads the carried cap");
    // Two reserves of 150 (300) only fit because 400 carried forward, not 100.
    const rs = await Promise.all(Array.from({ length: 3 }, () => checkAndReserve(WS_CD, 150)));
    assert.equal(rs.filter((r) => r.decision === "allow").length, 2);
    const row = await prisma.contextDevBudget.findUnique({
      where: { workspaceId_day: { workspaceId: WS_CD, day: todayKey() } },
    });
    assert.equal(row?.capCredits, 400, "today's row was seeded with the carried cap");
    assert.equal(row?.creditsUsed, 300, "usage itself does not carry over");
  });

  it("a workspace with no history starts at the default cap", async () => {
    await prisma.contextDevBudget.deleteMany({ where: { workspaceId: WS_CD } });
    assert.equal((await getDailyBudget(WS_CD)).capCredits, DEFAULT_DAILY_CAP_CREDITS);
  });
});

describe("first charge race on a new workspace", () => {
  // Regression (Phase 4c CI): lockBalance/lockSpendCap created the row with
  // create + catch P2002 and retried, but a unique violation aborts the
  // Postgres transaction, so every loser failed "current transaction is
  // aborted". The rows are now created with ON CONFLICT DO NOTHING.
  it("concurrent first meter() calls all succeed and charge exactly once each", async () => {
    const ws = `p4c-meter-first-${RUN}`;
    await createWorkspace(ws, "starter");
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => charge(ws, 1)));
      assert.deepEqual(results.map((r) => r.ok), Array(8).fill(true));
      const { bal, cap } = await state(ws);
      assert.equal(bal?.usedCredits, 8);
      assert.equal(cap?.capCredits, includedCreditsForPlan("starter"));
      assert.equal(cap?.blockAtCap, true);
    } finally {
      await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${ws}`;
    }
  });
});
