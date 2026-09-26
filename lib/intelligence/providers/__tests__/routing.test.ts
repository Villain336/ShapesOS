// Marketr — Phase 10 M6 tests: vendor routing selection logic.
// Run: npx tsx --test lib/intelligence/providers/__tests__/routing.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveVendor, DEFAULT_ROUTING, ALL_VENDORS } from "../routing";
import type { SerpVendorId } from "../types";

describe("resolveVendor — vendor selection", () => {
  it("routes AI-overview needs to talordata by default", () => {
    const v = resolveVendor({}, { needAiOverview: true }, ALL_VENDORS);
    assert.equal(v, "talordata");
  });

  it("routes ordinary SERP calls to the default vendor (serper)", () => {
    const v = resolveVendor({}, {}, ALL_VENDORS);
    assert.equal(v, "serper");
  });

  it("honors a configured default vendor override", () => {
    const v = resolveVendor({ default: "dataforseo" }, {}, ALL_VENDORS);
    assert.equal(v, "dataforseo");
  });

  it("honors a configured aiOverview vendor override", () => {
    const v = resolveVendor({ aiOverview: "dataforseo" }, { needAiOverview: true }, ALL_VENDORS);
    assert.equal(v, "dataforseo");
  });

  it("falls back when the preferred vendor is not configured", () => {
    const v = resolveVendor({}, { needAiOverview: true }, ["serper", "dataforseo"] as SerpVendorId[]);
    assert.equal(v, "dataforseo"); // first entry of default fallback chain that is configured
  });

  it("uses the custom fallback chain in order", () => {
    const v = resolveVendor({ default: "talordata", fallback: ["talordata", "serper"] }, {}, ["serper"] as SerpVendorId[]);
    assert.equal(v, "serper");
  });

  it("returns null when nothing is configured", () => {
    assert.equal(resolveVendor({}, {}, []), null);
  });

  it("ignores a default vendor id that is not in the known set", () => {
    const v = resolveVendor({ default: "nope" as SerpVendorId }, {}, ALL_VENDORS);
    // "nope" is not configured → falls through the fallback chain to a configured vendor
    assert.equal(v, "dataforseo");
  });

  it("DEFAULT_ROUTING matches the spec: talordata AIO, serper volume, dataforseo fallback", () => {
    assert.equal(DEFAULT_ROUTING.aiOverview, "talordata");
    assert.equal(DEFAULT_ROUTING.default, "serper");
    assert.ok(DEFAULT_ROUTING.fallback.includes("dataforseo"));
  });
});
