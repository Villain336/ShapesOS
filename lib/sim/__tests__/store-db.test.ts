// Phase 19B (WS=engine) — town persistence against real Postgres, as the
// least-privilege app role:
//   - FORCE RLS on all five sim tables: no GUC = zero rows, another
//     workspace = zero rows, a row for another workspace can't be written,
//     deleting the workspace cascades;
//   - sim_events is APPEND-ONLY for the app role: INSERT and SELECT work,
//     UPDATE and DELETE are refused (no grant); the run's delete still
//     cascades its events (the FK runs as the owner);
//   - the store's own reads: events after a cursor, the snapshot at an hour.
// Run: DATABASE_URL=<app role> npx tsx --test lib/sim/__tests__/store-db.test.ts

import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { generateTown } from "../generate";
import { appendEvents, createWorld, eventsAfter, insertSnapshots, snapshotAtOrBefore } from "../store.server";

const RUN = randomUUID().slice(0, 8);
const WS = `p19bse-${RUN}`;
const WS2 = `p19bse2-${RUN}`;
const TABLES = ["sim_worlds", "sim_runs", "sim_residents", "sim_events", "sim_snapshots"] as const;

async function seedEveryTable(ws: string): Promise<string> {
  const world = await createWorld(ws, { name: "Town", source: "generated", seed: 1, size: "small", layout: generateTown({ seed: 1, size: "small" }), createdBy: "u" });
  return withWorkspaceScope(ws, async (tx) => {
    const run = await tx.simRun.create({
      data: { workspaceId: ws, worldId: world.id, scenarioA: {}, population: 1, segments: [], personaSnapshot: [], days: 1, seeds: 1, baseSeed: 1, model: "m", estimate: {}, estimateCredits: 1, capCredits: 1, confirmedBy: "u" },
    });
    await tx.simResident.create({ data: { workspaceId: ws, runId: run.id, residentKey: "r001", name: "Ana R.", segment: "s", homeLotId: "home-1", workLotId: "work-1", routine: "weekday", data: {} } });
    await tx.simEvent.create({ data: { workspaceId: ws, runId: run.id, variant: "A", seedIndex: 0, seq: 0, t: 0, type: "day" } });
    await tx.simSnapshot.create({ data: { workspaceId: ws, runId: run.id, variant: "A", seedIndex: 0, hour: 0, t: 0, state: {} } });
    return run.id;
  });
}

async function count(table: string, ws: string | null): Promise<number> {
  const q = `SELECT count(*)::int AS n FROM "${table}"`;
  if (ws === null) return (await prisma.$queryRawUnsafe<Array<{ n: number }>>(q))[0]!.n;
  return withWorkspaceScope(ws, async (tx) => (await tx.$queryRawUnsafe<Array<{ n: number }>>(q))[0]!.n);
}

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS2] } } });
  await prisma.workspace.create({ data: { id: WS, name: `Town ${RUN}`, ownerUserId: `u-${RUN}` } });
  await prisma.workspace.create({ data: { id: WS2, name: `Other ${RUN}`, ownerUserId: `u2-${RUN}` } });
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS2] } } });
  await prisma.$disconnect();
});

describe("FORCE RLS on every sim table", () => {
  it("own workspace sees its row; no GUC and another workspace see none", async () => {
    await seedEveryTable(WS);
    for (const t of TABLES) {
      assert.equal(await count(t, WS), 1, `${t} under its own workspace`);
      assert.equal(await count(t, WS2), 0, `${t} under another workspace`);
      assert.equal(await count(t, null), 0, `${t} with no workspace set`);
    }
  });

  it("a row for another workspace cannot be written under this workspace's scope", async () => {
    await assert.rejects(
      withWorkspaceScope(WS, (tx) => tx.simWorld.create({ data: { workspaceId: WS2, name: "Smuggled", source: "generated", layout: {}, createdBy: "u" } })),
      /row-level security|violates/i,
    );
  });

  it("deleting the workspace cascades to every sim row (append-only events included)", async () => {
    const tmp = `p19bse3-${RUN}`;
    await prisma.workspace.create({ data: { id: tmp, name: "tmp", ownerUserId: "u" } });
    await seedEveryTable(tmp);
    await prisma.workspace.delete({ where: { id: tmp } });
    for (const t of TABLES) assert.equal(await count(t, tmp), 0, t);
  });
});

describe("sim_events is append-only for the app role", () => {
  it("INSERT and SELECT work; UPDATE and DELETE are refused", async () => {
    const runId = await seedEveryTable(WS);
    await appendEvents(WS, runId, "A", 0, [{ seq: 1, t: 5, type: "arrive", r: "r001", lot: "work-1", d: { activity: "work" } }]);
    assert.equal((await eventsAfter(WS, runId, "A", 0, -1, 10)).length, 2);
    await assert.rejects(withWorkspaceScope(WS, (tx) => tx.$executeRawUnsafe(`UPDATE "sim_events" SET "type" = 'buy' WHERE "run_id" = $1`, runId)), /permission denied/i);
    await assert.rejects(withWorkspaceScope(WS, (tx) => tx.$executeRawUnsafe(`DELETE FROM "sim_events" WHERE "run_id" = $1`, runId)), /permission denied/i);
    await assert.rejects(withWorkspaceScope(WS, (tx) => tx.simEvent.updateMany({ where: { runId }, data: { type: "x" } })), /permission denied/i);
    assert.equal((await eventsAfter(WS, runId, "A", 0, -1, 10)).length, 2, "nothing changed");
  });

  it("deleting the run still removes its events (FK cascade as the owner)", async () => {
    const runId = await seedEveryTable(WS);
    await withWorkspaceScope(WS, (tx) => tx.simRun.delete({ where: { id: runId } }));
    assert.equal(await withWorkspaceScope(WS, (tx) => tx.simEvent.count({ where: { runId } })), 0);
  });
});

describe("store reads", () => {
  it("events after a cursor in seq order; the latest snapshot at or before an hour", async () => {
    const runId = await seedEveryTable(WS);
    await appendEvents(WS, runId, "B", 0, [0, 1, 2, 3].map((i) => ({ seq: i, t: i * 60, type: "arrive" as const, r: "r001" })));
    assert.deepEqual((await eventsAfter(WS, runId, "B", 0, 1, 10)).map((e) => e.seq), [2, 3]);
    assert.deepEqual((await eventsAfter(WS, runId, "B", 0, -1, 2)).map((e) => e.seq), [0, 1]);
    await insertSnapshots(WS, runId, "B", 0, [
      { t: 0, residents: [], adopters: 0, visits: 0, yourRevenueCents: 0 },
      { t: 120, residents: [], adopters: 1, visits: 2, yourRevenueCents: 900 },
    ]);
    const s = await snapshotAtOrBefore(WS, runId, "B", 0, 3);
    assert.equal(s?.hour, 2);
    assert.equal(s?.state.visits, 2);
  });
});
