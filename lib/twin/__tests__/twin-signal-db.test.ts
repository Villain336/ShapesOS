// ShapesOS — Phase 17 (latency, A7): the twin change signal moves exactly
// when a record the snapshot reads changes (or the minute turns), and not
// for anything else; the live stream skips the snapshot while it does not
// move. App role, FORCE RLS.
// Run: DATABASE_URL=<app role> npx tsx --test lib/twin/__tests__/twin-signal-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createSampleSite } from "../sample";
import { siteSnapshot } from "../state";
import { etagMatches, siteSignal, twinEtag, TWIN_SIGNAL_BUCKET_MS } from "../signal";
import { twinLiveStream } from "../live";
import type { TwinSnapshot } from "../types";

const RUN = randomUUID().slice(0, 8);
const WS = `p17tw-${RUN}`;
const WS_B = `p17tw-b-${RUN}`;
let siteId = "";
let siteIdB = "";
// A fixed minute (mid-bucket) so only data changes move the version.
const NOW = new Date(Math.floor(Date.now() / TWIN_SIGNAL_BUCKET_MS) * TWIN_SIGNAL_BUCKET_MS + 30_000);

before(async () => {
  for (const id of [WS, WS_B]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: `o-${RUN}` } });
  siteId = (await withWorkspaceScope(WS, (tx) => createSampleSite(tx, { workspaceId: WS, userId: `o-${RUN}` }, "warehouse"), { timeoutMs: 60_000 })).siteId;
  siteIdB = (await withWorkspaceScope(WS_B, (tx) => createSampleSite(tx, { workspaceId: WS_B, userId: `o-${RUN}` }, "warehouse"), { timeoutMs: 60_000 })).siteId;
});

after(async () => {
  for (const id of [WS, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

const sig = async () => (await siteSignal(WS, siteId, NOW)).version;

describe("twin change signal", () => {
  it("is stable while nothing changes, and carries the site status", async () => {
    const a = await siteSignal(WS, siteId, NOW);
    assert.equal((await siteSignal(WS, siteId, NOW)).version, a.version);
    assert.equal(a.status, "draft");
  });

  it("moves when a layout object, a stock movement, a dock booking or the site itself changes", async () => {
    let v = await sig();
    const step = async (what: string, fn: () => Promise<unknown>) => {
      await fn();
      const next = await sig();
      assert.notEqual(next, v, `${what} must move the version`);
      v = next;
      assert.equal(await sig(), v, `…and it is stable again after ${what}`);
    };
    const obj = await withWorkspaceScope(WS, (tx) => tx.opsSiteObject.findFirstOrThrow({ where: { workspaceId: WS, siteId } }));
    await step("an object update", () => withWorkspaceScope(WS, (tx) => tx.opsSiteObject.update({ where: { id: obj.id }, data: { label: `${obj.label} (moved)` } })));
    const prod = await withWorkspaceScope(WS, (tx) => tx.opsProduct.findFirstOrThrow({ where: { workspaceId: WS } }));
    await step("a stock movement", () => withWorkspaceScope(WS, (tx) => tx.opsInventoryTxn.create({ data: { workspaceId: WS, productId: prod.id, delta: 3, reason: "adjustment" } })));
    const booking = await withWorkspaceScope(WS, (tx) => tx.opsDockBooking.findFirst({ where: { workspaceId: WS, siteId } }));
    if (booking) await step("a dock booking update", () => withWorkspaceScope(WS, (tx) => tx.opsDockBooking.update({ where: { id: booking.id }, data: { carrier: "Late Truck Co" } })));
    await step("a site status change", () => withWorkspaceScope(WS, (tx) => tx.opsSite.update({ where: { id: siteId }, data: { status: "published" } })));
    await step("an object delete", () => withWorkspaceScope(WS, (tx) => tx.opsSiteObject.delete({ where: { id: obj.id } })));
  });

  it("does NOT move for another workspace's records or for unrelated tables", async () => {
    const v = await sig();
    const objB = await withWorkspaceScope(WS_B, (tx) => tx.opsSiteObject.findFirstOrThrow({ where: { workspaceId: WS_B, siteId: siteIdB } }));
    await withWorkspaceScope(WS_B, (tx) => tx.opsSiteObject.update({ where: { id: objB.id }, data: { label: "B moved" } }));
    await withWorkspaceScope(WS, (tx) => tx.opsWarehouse.create({ data: { workspaceId: WS, name: "Unrelated", code: `UNREL-${RUN}` } }));
    assert.equal(await sig(), v);
  });

  it("moves when the minute turns (time-derived states), and reads as gone for another workspace", async () => {
    const v = await sig();
    assert.notEqual((await siteSignal(WS, siteId, new Date(NOW.getTime() + TWIN_SIGNAL_BUCKET_MS))).version, v);
    const foreign = await siteSignal(WS_B, siteId, NOW);
    assert.equal(foreign.status, null, "RLS: another workspace's site is gone");
  });

  it("ETag helpers", () => {
    assert.equal(twinEtag("abc"), '"twin-abc"');
    assert.ok(etagMatches('W/"twin-abc", "x"', "abc"));
    assert.ok(!etagMatches('"twin-abd"', "abc"));
    assert.ok(!etagMatches(null, "abc"));
  });

  it("the live stream skips the snapshot while the signal does not move", async () => {
    const first = await siteSnapshot(WS, siteId);
    let snapshots = 0;
    let version = "v1";
    let n = 0;
    const stream = twinLiveStream(first, {
      snapshot: async () => {
        snapshots++;
        return first as TwinSnapshot;
      },
      stillAllowed: async () => true,
      signal: async () => {
        if (++n === 6) version = "v2"; // a record changed after five quiet ticks
        return version;
      },
      pollMs: 5,
      maxMs: 300,
      sse: { register: () => () => undefined },
    });
    await new Response(stream).text();
    assert.equal(snapshots, 1, `one rebuild for one change (saw ${snapshots}) across ${n} ticks`);
    assert.ok(n > 6);
  });
});
