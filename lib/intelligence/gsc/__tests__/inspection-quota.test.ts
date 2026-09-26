// Marketr — Phase 10 M1 tests: URL Inspection queue quota + fairness.
// Run: npx tsx --test lib/intelligence/gsc/__tests__/inspection-quota.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueInspection,
  drainInspectionQueue,
  inspectionQuotaRemaining,
  INSPECTION_QPD_CAP,
  type QueueStore,
} from "../inspection";
import * as inspectionModule from "../inspection";

/** In-memory store so tests never touch the DB. */
function memoryStore() {
  const state = { queue: [] as never[], quota: {} as Record<string, { date: string; used: number }> };
  const store: QueueStore = {
    async load() {
      return JSON.parse(JSON.stringify(state)) as typeof state;
    },
    async save(_ws, next) {
      state.queue = next.queue as never[];
      state.quota = next.quota;
    },
  };
  return store;
}

const DAY1 = new Date("2026-09-20T12:00:00Z");
const DAY2 = new Date("2026-09-21T01:00:00Z");

async function enqueueMany(
  store: QueueStore,
  n: number,
  siteUrl: string,
  projectId = "p1",
  priority: 1 | 2 | 3 | 4 | 5 = 3,
) {
  for (let i = 0; i < n; i++) {
    await enqueueInspection(
      "ws1",
      { projectId, siteUrl, url: `${siteUrl}/page-${i}`, priority, reason: "test" },
      store,
    );
  }
}

describe("quota accounting", () => {
  it("never exceeds 2,000 inspections per site per day", async () => {
    const store = memoryStore();
    await enqueueMany(store, 2_050, "sc-domain:example.com");
    const drain = await drainInspectionQueue("ws1", { now: DAY1, store });
    assert.equal(drain.processed, INSPECTION_QPD_CAP);
    assert.equal(drain.remaining, 50);
    assert.equal(drain.quotaAfter["sc-domain:example.com"], INSPECTION_QPD_CAP);
    assert.equal(await inspectionQuotaRemaining("ws1", "sc-domain:example.com", { now: DAY1, store }), 0);
  });

  it("quota resets on the next UTC day", async () => {
    const store = memoryStore();
    await enqueueMany(store, 2_050, "sc-domain:example.com");
    await drainInspectionQueue("ws1", { now: DAY1, store });
    const drain2 = await drainInspectionQueue("ws1", { now: DAY2, store });
    assert.equal(drain2.processed, 50);
    assert.equal(drain2.remaining, 0);
  });

  it("quota is tracked per site independently", async () => {
    const store = memoryStore();
    await enqueueMany(store, 2_000, "sc-domain:a.com");
    await enqueueMany(store, 10, "sc-domain:b.com");
    const drain = await drainInspectionQueue("ws1", { now: DAY1, store });
    assert.equal(drain.processed, 2_010);
    assert.equal(drain.quotaAfter["sc-domain:b.com"], 10);
  });
});

describe("priority + fair-share ordering", () => {
  it("serves higher priority first", async () => {
    const store = memoryStore();
    await enqueueMany(store, 3, "sc-domain:example.com", "p1", 1);
    await enqueueMany(store, 1, "sc-domain:example.com", "p1", 5);
    const drain = await drainInspectionQueue("ws1", { now: DAY1, store });
    assert.equal(drain.results[0].request.priority, 5);
  });

  it("fair-shares across projects at equal priority (round-robin)", async () => {
    const store = memoryStore();
    await enqueueMany(store, 6, "sc-domain:example.com", "projA", 3);
    await enqueueMany(store, 6, "sc-domain:example.com", "projB", 3);
    const drain = await drainInspectionQueue("ws1", { now: DAY1, store });
    const order = drain.results.map((r) => r.request.projectId);
    // Strict alternation: A B A B ... (fair-share, never starves B)
    for (let i = 0; i < order.length; i++) {
      assert.equal(order[i], i % 2 === 0 ? "projA" : "projB");
    }
  });

  it("stub results are flagged and make no live call", async () => {
    const store = memoryStore();
    await enqueueMany(store, 1, "sc-domain:example.com", "p1", 5);
    const drain = await drainInspectionQueue("ws1", { now: DAY1, store });
    assert.equal(drain.results[0].result.stub, true);
  });
});

describe("no sweep API", () => {
  it("the module exposes no bulk inspect-all operation", () => {
    const names = Object.keys(inspectionModule);
    assert.ok(!names.some((n) => /sweep|all|bulk/i.test(n)), `no sweep export: ${names.join(",")}`);
  });
});
