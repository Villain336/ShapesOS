// Marketr — Phase 11 "Canvas": session assets store tests.
// Run: npx tsx --test lib/design/__tests__/assets.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { newAssetId, useSessionAssets, type SessionAsset } from "../assets";

function asset(name: string, origin: SessionAsset["origin"] = "upload"): SessionAsset {
  return { id: newAssetId("t"), name, dataUrl: "data:image/png;base64,xx", width: 10, height: 10, origin };
}

beforeEach(() => {
  useSessionAssets.getState().clear();
});

describe("useSessionAssets", () => {
  it("prepends new assets (newest first)", () => {
    const s = useSessionAssets.getState();
    s.addAssets([asset("first")]);
    s.addAssets([asset("second")]);
    const names = useSessionAssets.getState().assets.map((a) => a.name);
    assert.deepEqual(names, ["second", "first"]);
  });

  it("removes one asset by id", () => {
    const s = useSessionAssets.getState();
    const a = asset("gone");
    s.addAssets([a, asset("stays")]);
    s.removeAsset(a.id);
    const names = useSessionAssets.getState().assets.map((x) => x.name);
    assert.deepEqual(names, ["stays"]);
  });

  it("keeps upload and generated origins distinct", () => {
    useSessionAssets.getState().addAssets([asset("u", "upload"), asset("g", "generated")]);
    const origins = useSessionAssets.getState().assets.map((a) => a.origin);
    assert.deepEqual(origins, ["u", "g"].map((n) => (n === "u" ? "upload" : "generated")));
  });

  it("generates unique ids", () => {
    const ids = new Set([newAssetId("x"), newAssetId("x"), newAssetId("x")]);
    assert.equal(ids.size, 3);
  });
});
