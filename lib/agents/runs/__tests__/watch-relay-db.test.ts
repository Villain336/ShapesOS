// Deploy PR (WS=state): live watch across processes through the Postgres
// relay (agent_run_watch_frames). Run as the least-privilege app role:
//   DATABASE_URL=<app role> npx tsx --test lib/agents/runs/__tests__/watch-relay-db.test.ts
//
// The producer is this process's watch registry (exactly what the worker
// runs); "another process" is a subscriber that reads ONLY the relay
// (_relaySubscriptionForTests), which is what a web replica does.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createAgentRun } from "../service";
import {
  _relaySubscriptionForTests,
  _resetWatchRegistryForTests,
  endWatchStream,
  getWatchStreamAccess,
  isWatchStreamLive,
  publishWatchFrame,
  startWatchStream,
} from "../watch";
import { postgresWatchRelay } from "../watch-relay";

const RUN = `deploy-watch-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const JPEG_1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]);
const JPEG_2 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 2, 0xff, 0xd9]);

const row = (runId: string) =>
  withWorkspaceScope(WS_A, (tx) => tx.agentRunWatchFrame.findUnique({ where: { runId } }));

before(async () => {
  _resetWatchRegistryForTests();
  for (const id of [WS_A, WS_B]) await prisma.workspace.create({ data: { id, name: `deploy ${id}`, ownerUserId: "deploy-owner" } });
});

after(async () => {
  _resetWatchRegistryForTests();
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("live watch relay (worker → any web replica)", () => {
  it("frames reach a subscriber in another process; only while watched; RLS-scoped; deleted at the end", async () => {
    const run = await createAgentRun({ workspaceId: WS_A, kind: "browser", startedBy: "agent:test" });
    startWatchStream(run.id, { workspaceId: WS_A });
    publishWatchFrame(run.id, JPEG_1);
    await new Promise((r) => setTimeout(r, 2_500)); // ≥ one producer heartbeat
    const unwatched = await row(run.id);
    assert.ok(unwatched, "the producer opened its relay row");
    assert.equal(unwatched!.jpeg, null, "nobody watches → no frame is uploaded");
    assert.equal(await prisma.agentRunWatchFrame.count(), 0, "FORCE RLS: invisible without the workspace GUC");

    // Another process starts watching: within a heartbeat it gets the latest frame.
    const sub = _relaySubscriptionForTests(WS_A, run.id);
    const first = await sub.nextFrame(6_000);
    assert.ok(first && !("ended" in first), `expected a frame, got ${JSON.stringify(first)}`);
    assert.ok(first.jpeg.equals(JPEG_1));
    publishWatchFrame(run.id, JPEG_2);
    const second = await sub.nextFrame(6_000);
    assert.ok(second && !("ended" in second));
    assert.ok(second.jpeg.equals(JPEG_2));
    assert.ok(second.seq > first.seq, "latest-wins sequence");

    // Access as the SSE route checks it: live in A (any process), not in B.
    assert.equal(await isWatchStreamLive(WS_A, run.id), true);
    assert.ok(await getWatchStreamAccess(WS_A, run.id));
    assert.equal(await getWatchStreamAccess(WS_B, run.id), null);
    assert.deepEqual(await _relaySubscriptionForTests(WS_B, run.id).nextFrame(500), { ended: true }, "workspace B sees no stream");

    await endWatchStream(run.id);
    assert.equal(await row(run.id), null, "frames are transient: the row is gone");
    assert.deepEqual(await sub.nextFrame(1_000), { ended: true });
    assert.equal(await isWatchStreamLive(WS_A, run.id), false);
  });

  it("a producer that stops heart-beating (crashed worker) reads as ended", async () => {
    const run = await createAgentRun({ workspaceId: WS_A, kind: "browser", startedBy: "agent:test" });
    const relay = postgresWatchRelay();
    await relay.open(WS_A, run.id);
    assert.equal(await relay.isLive(WS_A, run.id), true);
    await withWorkspaceScope(WS_A, (tx) => tx.$executeRaw`UPDATE "agent_run_watch_frames" SET "updated_at" = now() - interval '1 minute' WHERE "run_id" = ${run.id}`);
    assert.equal(await relay.isLive(WS_A, run.id), false);
    assert.deepEqual(await relay.poll(WS_A, run.id, 0), { state: "ended" });
    await relay.end(WS_A, run.id);
  });

  it("deleting the run cascades its relay row", async () => {
    const run = await createAgentRun({ workspaceId: WS_A, kind: "browser", startedBy: "agent:test" });
    const relay = postgresWatchRelay();
    await relay.open(WS_A, run.id);
    await withWorkspaceScope(WS_A, (tx) => tx.agentRun.delete({ where: { id: run.id } }));
    assert.equal(await row(run.id), null);
  });
});
