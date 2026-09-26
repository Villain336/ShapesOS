// Marketr — Phase 10 M6 tests: volume cache (hit/miss/TTL/invalidation-on-use).
// Run: npx tsx --test lib/intelligence/providers/__tests__/volume.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  volumeCacheKey,
  isCacheFresh,
  refreshExpiry,
  plannerVolumeLookup,
  lookupVolume,
  type VolumeCacheStore,
  type VolumeLookupResult,
} from "../volume";
import { PlannerNotReady, type VolumeBand } from "../types";

function memStore(): VolumeCacheStore & {
  rows: Map<string, { volumeBand: string; fetchedAt: Date; expiresAt: Date }>;
  refreshes: number;
  writes: number;
} {
  const rows = new Map<string, { volumeBand: string; fetchedAt: Date; expiresAt: Date }>();
  return {
    rows,
    refreshes: 0,
    writes: 0,
    async read(key, locale) {
      return rows.get(`${key}|${locale}`) ?? null;
    },
    async refresh(key, locale, expiresAt) {
      const r = rows.get(`${key}|${locale}`);
      if (r) {
        r.expiresAt = expiresAt;
        this.refreshes += 1;
      }
    },
    async write(key, locale, band, _source, ttlDays) {
      const now = new Date();
      rows.set(`${key}|${locale}`, {
        volumeBand: band,
        fetchedAt: now,
        expiresAt: new Date(now.getTime() + ttlDays * 86_400_000),
      });
      this.writes += 1;
    },
  };
}

const NOOP_DEPS = {
  budgetCheck: async () => {},
  meter: async () => {},
  audit: async () => {},
};

describe("volumeCacheKey", () => {
  it("is deterministic and case/whitespace-insensitive", () => {
    assert.equal(volumeCacheKey("Best CRM", "en-US"), volumeCacheKey("best crm", "en-us"));
    assert.equal(volumeCacheKey(" best crm ", "en-US"), volumeCacheKey("best crm", "en-us"));
  });

  it("differs per keyword and per locale", () => {
    assert.notEqual(volumeCacheKey("crm", "en-US"), volumeCacheKey("cms", "en-US"));
    assert.notEqual(volumeCacheKey("crm", "en-US"), volumeCacheKey("crm", "en-GB"));
  });

  it("is a 64-char sha256 hex", () => {
    assert.match(volumeCacheKey("crm", "en-US"), /^[0-9a-f]{64}$/);
  });
});

describe("isCacheFresh / refreshExpiry", () => {
  it("treats expired rows as stale", () => {
    assert.equal(isCacheFresh(new Date(Date.now() - 1)), false);
    assert.equal(isCacheFresh(new Date(Date.now() + 60_000)), true);
  });

  it("slides expiry forward on use within TTL", () => {
    const fetchedAt = new Date(Date.now() - 10 * 86_400_000);
    const now = new Date();
    const refreshed = refreshExpiry(fetchedAt, 60, 90, now);
    assert.ok(Math.abs(refreshed.getTime() - (now.getTime() + 60 * 86_400_000)) < 1000);
  });

  it("hard-caps the sliding window at max TTL from original fetch (no shadow DB)", () => {
    const fetchedAt = new Date(Date.now() - 85 * 86_400_000);
    const now = new Date();
    const refreshed = refreshExpiry(fetchedAt, 60, 90, now);
    // Sliding would give now+60d (145d after fetch); cap gives 90d after fetch.
    assert.ok(Math.abs(refreshed.getTime() - (fetchedAt.getTime() + 90 * 86_400_000)) < 1000);
  });
});

describe("plannerVolumeLookup (stub)", () => {
  it("raises PlannerNotReady (typed), never crashes", async () => {
    await assert.rejects(() => plannerVolumeLookup("crm", "en-US"), PlannerNotReady);
  });
});

describe("lookupVolume flow", () => {
  it("miss: planner first, then vendor bulk; caches a band", async () => {
    const store = memStore();
    const metered: Array<{ vendor: string; cost: number }> = [];
    const plannerCalls: string[] = [];
    const planner = async (kw: string, _loc: string): Promise<VolumeLookupResult> => {
      plannerCalls.push(kw);
      throw new PlannerNotReady();
    };
    const r = await lookupVolume("ws1", "crm software", "en-US", {
      ...NOOP_DEPS,
      cache: store,
      planner,
      vendorVolume: async () => ({ band: "10K–100K" as VolumeBand, costUsd: 0.000132 }),
      meter: async (vendor, cost) => {
        metered.push({ vendor, cost });
      },
    });
    assert.equal(r.band, "10K–100K");
    assert.equal(r.source, "vendor");
    assert.deepEqual(plannerCalls, ["crm software"]); // planner attempted before vendor
    assert.equal(store.writes, 1);
    assert.deepEqual(metered, [{ vendor: "vendor", cost: 0.000132 }]);
  });

  it("hit: serves from cache, refreshes expiry (invalidation-on-use), meters $0", async () => {
    const store = memStore();
    const key = volumeCacheKey("crm software", "en-US");
    const fetchedAt = new Date(Date.now() - 5 * 86_400_000);
    const before = new Date(Date.now() + 55 * 86_400_000);
    store.rows.set(`${key}|en-US`, { volumeBand: "1K–10K", fetchedAt, expiresAt: before });
    const metered: Array<{ vendor: string; cost: number }> = [];
    const vendorCalls: string[] = [];
    const r = await lookupVolume("ws1", "crm software", "en-US", {
      ...NOOP_DEPS,
      cache: store,
      vendorVolume: async (kw) => {
        vendorCalls.push(kw);
        return { band: "1M+" as VolumeBand, costUsd: 1 };
      },
      meter: async (vendor, cost) => {
        metered.push({ vendor, cost });
      },
    });
    assert.equal(r.band, "1K–10K");
    assert.equal(r.source, "cache");
    assert.deepEqual(vendorCalls, []); // vendor never touched on hit
    assert.equal(store.refreshes, 1);
    const row = store.rows.get(`${key}|en-US`)!;
    assert.ok(row.expiresAt.getTime() > before.getTime()); // expiry slid forward
    assert.deepEqual(metered, [{ vendor: "volume_cache", cost: 0 }]);
  });

  it("stale row: treated as miss, refetched", async () => {
    const store = memStore();
    const key = volumeCacheKey("crm software", "en-US");
    store.rows.set(`${key}|en-US`, {
      volumeBand: "1K–10K",
      fetchedAt: new Date(Date.now() - 100 * 86_400_000),
      expiresAt: new Date(Date.now() - 1000),
    });
    const r = await lookupVolume("ws1", "crm software", "en-US", {
      ...NOOP_DEPS,
      cache: store,
      planner: async () => {
        throw new PlannerNotReady();
      },
      vendorVolume: async () => ({ band: "100–1K" as VolumeBand, costUsd: 0 }),
    });
    assert.equal(r.source, "vendor");
    assert.equal(r.band, "100–1K");
  });

  it("miss with no vendor: raises VolumeUnavailableError (typed)", async () => {
    const { VolumeUnavailableError } = await import("../types");
    await assert.rejects(
      () =>
        lookupVolume("ws1", "crm software", "en-US", {
          ...NOOP_DEPS,
          cache: memStore(),
          planner: async () => {
            throw new PlannerNotReady();
          },
          vendorVolume: async () => null,
        }),
      VolumeUnavailableError,
    );
  });

  it("non-band row in cache: refuses to serve", async () => {
    const store = memStore();
    const key = volumeCacheKey("crm software", "en-US");
    store.rows.set(`${key}|en-US`, {
      volumeBand: "4521", // corrupt: a point, not a band
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await assert.rejects(
      () => lookupVolume("ws1", "crm software", "en-US", { ...NOOP_DEPS, cache: store }),
      /non-band/,
    );
  });
});
