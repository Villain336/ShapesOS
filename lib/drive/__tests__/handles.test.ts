// ShapesOS — Phase 21B (WS=drive): file-picker handles (unit).
// Run: npx tsx --test lib/drive/__tests__/handles.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HANDLE_MAX_TTL_MS, signHandle, verifyHandle } from "../handles";

const secret = "x".repeat(32);
const claims = { ws: "w1", app: "crm/i1", file: "f1", by: "u1", mode: "read" as const };
const now = Date.parse("2026-11-02T10:00:00Z");

describe("signHandle / verifyHandle", () => {
  it("round-trips the claims for the right app install", () => {
    const h = signHandle(claims, secret, { now, ttlMs: 60_000 });
    const v = verifyHandle(h, secret, { app: "crm/i1", now: now + 1000 });
    assert.deepEqual(v, { ok: true, claims: { v: 1, ...claims, exp: now + 60_000 } });
  });
  it("refuses another app install, a wrong secret, a tampered body, an expired handle and garbage", () => {
    const h = signHandle(claims, secret, { now, ttlMs: 60_000 });
    assert.deepEqual(verifyHandle(h, secret, { app: "crm/i2", now }), { ok: false, reason: "app" });
    assert.deepEqual(verifyHandle(h, "y".repeat(32), { app: "crm/i1", now }), { ok: false, reason: "signature" });
    const [body, sig] = h.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, ...claims, file: "f2", exp: now + 60_000 })).toString("base64url");
    assert.deepEqual(verifyHandle(`${forged}.${sig}`, secret, { app: "crm/i1", now }), { ok: false, reason: "signature" });
    assert.ok(body);
    assert.deepEqual(verifyHandle(h, secret, { app: "crm/i1", now: now + 61_000 }), { ok: false, reason: "expired" });
    assert.deepEqual(verifyHandle("nonsense", secret, { app: "crm/i1", now }), { ok: false, reason: "malformed" });
    assert.deepEqual(verifyHandle("a.b.c", secret, { app: "crm/i1", now }), { ok: false, reason: "malformed" });
  });
  it("caps the lifetime at 24 hours and refuses an empty secret", () => {
    const h = signHandle(claims, secret, { now, ttlMs: 10 * 24 * 3600_000 });
    const v = verifyHandle(h, secret, { app: "crm/i1", now });
    assert.ok(v.ok && v.claims.exp === now + HANDLE_MAX_TTL_MS);
    assert.throws(() => signHandle(claims, "", { now }), /secret/i);
  });
});
