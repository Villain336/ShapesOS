// Marketr — Phase 10 M6 tests: kill-switch.
// The M7 battery flips the default vendor in config; every consumer must
// keep working through the abstraction. Consumers = fetchSerp here.
// Run: npx tsx --test lib/intelligence/providers/__tests__/killswitch.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchSerp } from "../routing";
import {
  VendorNotConfigured,
  type SerpProvider,
  type SerpResponse,
  type SerpVendorId,
} from "../types";

function fakeAdapter(vendor: SerpVendorId, configured: boolean): SerpProvider {
  return {
    vendor,
    isConfigured: () => configured,
    costPerSerpCallUsd: () => 0.001,
    search: async (keyword, locale, opts) => {
      const r: SerpResponse = {
        keyword,
        locale,
        results: [{ position: 1, url: "https://example.com", domain: "example.com", title: "Example" }],
        aiOverviewPresent: opts?.needAiOverview === true && vendor === "talordata",
        serpFeatures: [],
        fetchedAt: new Date(),
        vendor,
        costUsd: 0.001,
      };
      return r;
    },
  };
}

const ALL_FAKE = {
  serper: fakeAdapter("serper", true),
  dataforseo: fakeAdapter("dataforseo", true),
  talordata: fakeAdapter("talordata", true),
};

const NOOP = { budgetCheck: async () => {}, meter: async () => {}, audit: async () => {} };

describe("kill-switch: default vendor flip keeps consumers working", () => {
  it("baseline: default serper serves consumers", async () => {
    const r = await fetchSerp("ws1", "crm", "en-US", {}, { adapters: ALL_FAKE, routingRules: {}, ...NOOP });
    assert.equal(r.vendor, "serper");
    assert.equal(r.results.length, 1);
  });

  it("flipped to dataforseo: consumers keep working (config change only)", async () => {
    const r = await fetchSerp(
      "ws1",
      "crm",
      "en-US",
      {},
      { adapters: ALL_FAKE, routingRules: { default: "dataforseo" }, ...NOOP },
    );
    assert.equal(r.vendor, "dataforseo");
  });

  it("flipped to talordata with needAiOverview: AIO-capable vendor serves", async () => {
    const r = await fetchSerp(
      "ws1",
      "crm",
      "en-US",
      { needAiOverview: true },
      { adapters: ALL_FAKE, routingRules: { default: "talordata" }, ...NOOP },
    );
    assert.equal(r.vendor, "talordata");
    assert.equal(r.aiOverviewPresent, true);
  });

  it("flipped default becomes unconfigured: fallback chain keeps serving", async () => {
    const adapters = {
      ...ALL_FAKE,
      talordata: fakeAdapter("talordata", false),
    };
    const r = await fetchSerp(
      "ws1",
      "crm",
      "en-US",
      {},
      { adapters, routingRules: { default: "talordata", fallback: ["dataforseo"] }, ...NOOP },
    );
    assert.equal(r.vendor, "dataforseo");
  });

  it("no vendor configured anywhere: typed VendorNotConfigured, never a crash", async () => {
    const none = {
      serper: fakeAdapter("serper", false),
      dataforseo: fakeAdapter("dataforseo", false),
      talordata: fakeAdapter("talordata", false),
    };
    await assert.rejects(() => fetchSerp("ws1", "crm", "en-US", {}, { adapters: none, routingRules: {}, ...NOOP }), VendorNotConfigured);
  });

  it("circuit breaker trips before the vendor is called", async () => {
    let searched = false;
    const adapters = {
      serper: {
        ...fakeAdapter("serper", true),
        search: async (...a: Parameters<SerpProvider["search"]>) => {
          searched = true;
          return fakeAdapter("serper", true).search(...a);
        },
      },
      dataforseo: fakeAdapter("dataforseo", false),
      talordata: fakeAdapter("talordata", false),
    };
    class BudgetBlocked extends Error {}
    await assert.rejects(
      () =>
        fetchSerp("ws1", "crm", "en-US", {}, {
          adapters,
          routingRules: {},
          ...NOOP,
          budgetCheck: async () => {
            throw new BudgetBlocked("cap");
          },
        }),
      BudgetBlocked,
    );
    assert.equal(searched, false); // vendor never called when the budget is gone
  });
});
