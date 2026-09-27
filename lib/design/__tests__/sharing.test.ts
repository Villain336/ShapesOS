// Marketr — Phase 11 "Canvas": share-token helper tests (Feature 6).
// Run: npx tsx --test lib/design/__tests__/sharing.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { hashShareToken, newShareToken, shareUrl } from "../sharing";

describe("share tokens", () => {
  it("generates unique URL-safe tokens", () => {
    const a = newShareToken();
    const b = newShareToken();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
    assert.equal(a.length, 43); // 32 bytes base64url, no padding
  });

  it("hashes deterministically with SHA-256 and never leaks the token", () => {
    const token = newShareToken();
    const h1 = hashShareToken(token);
    const h2 = hashShareToken(token);
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.ok(!h1.includes(token.slice(0, 8)));
    assert.notEqual(hashShareToken(newShareToken()), h1);
  });

  it("builds the public share URL", () => {
    const url = shareUrl("https://app.example.com/", "tok123");
    assert.equal(url, "https://app.example.com/s/tok123");
  });
});
