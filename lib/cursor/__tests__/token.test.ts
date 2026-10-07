// Phase 19A (WS=server): the cursor session token — expiry, tamper, wrong
// workspace, lifetime cap, and no token without a secret.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { CURSOR_TOKEN_TTL_MS, bearerCursorToken, cursorTokenSecret, signCursorToken, verifyCursorToken } from "../token";

const SECRET = "test-secret-0123456789abcdef";
const NOW = 1_800_000_000_000;

describe("cursor token", () => {
  it("round-trips user and workspace, ≤ 10 minutes", () => {
    const { token, expiresAt } = signCursorToken({ userId: "u1", workspaceId: "w1" }, SECRET, NOW);
    assert.equal(expiresAt - NOW, CURSOR_TOKEN_TTL_MS);
    assert.ok(CURSOR_TOKEN_TTL_MS <= 10 * 60_000);
    const v = verifyCursorToken(token, SECRET, { now: NOW + 1000, workspaceId: "w1" });
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual([v.claims.uid, v.claims.ws], ["u1", "w1"]);
  });

  it("expires", () => {
    const { token } = signCursorToken({ userId: "u1", workspaceId: "w1" }, SECRET, NOW);
    assert.deepEqual(verifyCursorToken(token, SECRET, { now: NOW + CURSOR_TOKEN_TTL_MS }), { ok: false, reason: "expired" });
  });

  it("refuses a tampered body or signature, and another secret", () => {
    const { token } = signCursorToken({ userId: "u1", workspaceId: "w1" }, SECRET, NOW);
    const [prefix, rest] = [token.slice(0, 5), token.slice(5)];
    const [body, sig] = rest.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, uid: "admin", ws: "w1", iat: NOW, exp: NOW + 60_000 })).toString("base64url");
    assert.equal(verifyCursorToken(`${prefix}${forged}.${sig}`, SECRET, { now: NOW }).ok, false);
    assert.equal(verifyCursorToken(`${prefix}${body}.${sig}x`, SECRET, { now: NOW }).ok, false);
    assert.equal(verifyCursorToken(token, "another-secret-0123456789", { now: NOW }).ok, false);
    assert.deepEqual(verifyCursorToken("garbage", SECRET, { now: NOW }), { ok: false, reason: "malformed" });
  });

  it("refuses a token bound to another workspace", () => {
    const { token } = signCursorToken({ userId: "u1", workspaceId: "w1" }, SECRET, NOW);
    assert.deepEqual(verifyCursorToken(token, SECRET, { now: NOW, workspaceId: "w2" }), { ok: false, reason: "workspace" });
  });

  it("refuses a correctly signed token that claims a lifetime past the cap", () => {
    const body = Buffer.from(JSON.stringify({ v: 1, uid: "u1", ws: "w1", iat: NOW, exp: NOW + 24 * 3600_000 })).toString("base64url");
    const key = createHmac("sha256", SECRET).update("shapes:cursor-token:v1").digest();
    const sig = createHmac("sha256", key).update(body).digest("base64url");
    assert.deepEqual(verifyCursorToken(`cur1.${body}.${sig}`, SECRET, { now: NOW }), { ok: false, reason: "claims" });
  });

  it("no secret → no token", () => {
    assert.equal(cursorTokenSecret({}), null);
    assert.equal(cursorTokenSecret({ AUTH_SECRET: "short" }), null);
    assert.equal(cursorTokenSecret({ NEXTAUTH_SECRET: SECRET }), SECRET);
  });

  it("reads only cursor bearer tokens", () => {
    assert.equal(bearerCursorToken(new Headers({ authorization: "Bearer cur1.abc.def" })), "cur1.abc.def");
    assert.equal(bearerCursorToken(new Headers({ authorization: "Bearer sk_live_x" })), null);
    assert.equal(bearerCursorToken(new Headers()), null);
  });
});
