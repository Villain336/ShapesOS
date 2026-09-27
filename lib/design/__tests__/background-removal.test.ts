// Marketr — Phase 11 "Canvas": background-removal module tests.
// The WASM engine itself is lazy-loaded and browser-only (covered by manual
// verification); here we pin the module's pure contract.
// Run: npx tsx --test lib/design/__tests__/background-removal.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isBgEngineReady } from "../background-removal";

describe("background-removal module", () => {
  it("reports the engine as not-ready before any load is attempted", () => {
    assert.equal(isBgEngineReady(), false);
  });

  it("exports a removeImageBackground function", async () => {
    const mod = await import("../background-removal");
    assert.equal(typeof mod.removeImageBackground, "function");
  });
});
