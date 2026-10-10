// ShapesOS — Phase 21B (WS=drive): quota maths (unit).
// Run: npx tsx --test lib/drive/__tests__/quota.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_APP_QUOTA_BYTES, checkQuotaChange, quotaScopesFor, uploadLimitBytes } from "../quota";

const GB = 1024 ** 3;

describe("quotaScopesFor", () => {
  it("charges a private home to its owner, an app container to its install, the rest to the workspace only", () => {
    assert.deepEqual(quotaScopesFor({ ownerUserId: "u1", app: null }), [{ kind: "user", key: "user:u1" }]);
    assert.deepEqual(quotaScopesFor({ ownerUserId: null, app: { appId: "crm", install: "i1" } }), [{ kind: "app", key: "app:crm/i1" }]);
    assert.deepEqual(quotaScopesFor({ ownerUserId: null, app: null }), []);
  });
});

describe("checkQuotaChange", () => {
  const ws = { limit: 10 * GB, used: 9 * GB };

  it("allows a write that fits the workspace and every scope", () => {
    assert.deepEqual(checkQuotaChange({ workspace: ws, scopes: [{ key: "user:u1", limit: 1 * GB, used: 0 }], delta: 1 * GB }), { ok: true });
  });

  it("refuses at the workspace limit, naming it", () => {
    const r = checkQuotaChange({ workspace: ws, scopes: [], delta: 1 * GB + 1 });
    assert.deepEqual(r, { ok: false, scope: "workspace", limit: 10 * GB, used: 9 * GB, over: 1 });
  });

  it("refuses at a scope limit even when the workspace has room, naming the scope", () => {
    const r = checkQuotaChange({ workspace: { limit: 100 * GB, used: 0 }, scopes: [{ key: "app:crm/i1", limit: 100, used: 90 }], delta: 11 });
    assert.deepEqual(r, { ok: false, scope: "app:crm/i1", limit: 100, used: 90, over: 1 });
  });

  it("treats a null scope limit as unlimited (only the workspace limit applies)", () => {
    assert.deepEqual(checkQuotaChange({ workspace: ws, scopes: [{ key: "user:u1", limit: null, used: 5 * GB }], delta: 1 }), { ok: true });
  });

  it("always allows freeing space, even when over the limit", () => {
    assert.deepEqual(checkQuotaChange({ workspace: { limit: 10, used: 50 }, scopes: [{ key: "user:u1", limit: 10, used: 50 }], delta: -20 }), { ok: true });
  });

  it("allows exactly filling the limit", () => {
    assert.deepEqual(checkQuotaChange({ workspace: { limit: 10, used: 4 }, scopes: [], delta: 6 }), { ok: true });
  });
});

describe("defaults", () => {
  it("gives an app install 1 GiB unless set", () => {
    assert.equal(DEFAULT_APP_QUOTA_BYTES, 1073741824);
  });
});

describe("uploadLimitBytes (the per-upload cap becomes quota-governed)", () => {
  it("is the smaller of the hard maximum and the room left", () => {
    assert.equal(uploadLimitBytes({ hardMax: 5 * GB, room: 2 * GB }), 2 * GB);
    assert.equal(uploadLimitBytes({ hardMax: 1 * GB, room: 2 * GB }), 1 * GB);
    assert.equal(uploadLimitBytes({ hardMax: 1 * GB, room: -5 }), 0);
  });
});
