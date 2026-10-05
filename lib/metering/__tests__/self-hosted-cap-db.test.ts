// ShapesOS — self-hosted metering records usage but never blocks (BYO provider
// keys, lib/metering/credits.ts). Regression for the Phase 2 merge: the cap row
// was created with block_at_cap = true and a 0-credit pool, so every metered
// action on a self-hosted workspace — messaging included once it started
// metering before send — was refused. Crossing the self-hosted boundary in a
// plan change flips blocking; billed plans keep the hard cap.
// Run (DB suite): DATABASE_URL=… npx tsx --test lib/metering/__tests__/self-hosted-cap-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { applyPlanChange, meter } from "../service";

// usage_events is append-only (a trigger refuses DELETE), so ids are unique per run.
const RUN = randomUUID().slice(0, 8);
const WS_SELF = `p2-selfhost-${RUN}`;
const WS_FLIP = `p2-selfhost-flip-${RUN}`;

async function createWorkspace(id: string, plan: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspaces (id, name, owner_user_id, plan, updated_at)
     VALUES ($1, $1, $2, $3::"Plan", now()) ON CONFLICT (id) DO UPDATE SET plan = EXCLUDED.plan`,
    id,
    `test:${id}`,
    plan,
  );
}

const charge = (workspaceId: string, credits: number) =>
  meter({ workspaceId, action: "rank_check", idempotencyKey: `p2-sh-${randomUUID()}`, credits });

before(async () => {
  await createWorkspace(WS_SELF, "self_hosted");
  await createWorkspace(WS_FLIP, "self_hosted");
});

after(async () => {
  await prisma.$disconnect();
});

describe("self-hosted metering", () => {
  it("records usage past the 0-credit pool instead of blocking", async () => {
    const r = await charge(WS_SELF, 50);
    assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
    const cap = await prisma.spendCap.findUnique({ where: { workspaceId: WS_SELF } });
    assert.equal(cap?.blockAtCap, false);
    const bal = await prisma.creditBalance.findUnique({ where: { workspaceId: WS_SELF } });
    assert.equal(bal?.usedCredits, 50);
  });

  it("upgrading to a billed plan turns the hard cap on; moving back turns it off", async () => {
    await charge(WS_FLIP, 1); // creates the (non-blocking) cap row
    await applyPlanChange(WS_FLIP, "starter");
    let cap = await prisma.spendCap.findUnique({ where: { workspaceId: WS_FLIP } });
    assert.equal(cap?.blockAtCap, true);

    await applyPlanChange(WS_FLIP, "self_hosted");
    cap = await prisma.spendCap.findUnique({ where: { workspaceId: WS_FLIP } });
    assert.equal(cap?.blockAtCap, false);
  });

  it("a plan change that stays on billed plans keeps the admin's blocking choice", async () => {
    await applyPlanChange(WS_FLIP, "starter");
    await prisma.spendCap.update({ where: { workspaceId: WS_FLIP }, data: { blockAtCap: false } });
    await applyPlanChange(WS_FLIP, "pro");
    const cap = await prisma.spendCap.findUnique({ where: { workspaceId: WS_FLIP } });
    assert.equal(cap?.blockAtCap, false);
  });
});
