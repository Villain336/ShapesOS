// ShapesOS — Phase 1 tests: platform operators gate host-wide resources
// (shared Knowledge corpus mutations, Activepieces flow bindings).
// Run: npx tsx --test lib/auth/__tests__/platform-operator.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlatformOperator, platformOperatorList } from "../platform-operator";
import { requirePlatformOperator } from "../require-platform-operator";

const ROOT = join(__dirname, "..", "..", "..");
const ENV = { MARKETR_PLATFORM_OPERATORS: " ops@example.com , user_op " } as NodeJS.ProcessEnv;

describe("isPlatformOperator", () => {
  it("nobody is an operator when unset (fail closed)", () => {
    assert.deepEqual(platformOperatorList({} as NodeJS.ProcessEnv), []);
    assert.equal(isPlatformOperator({ id: "user_op", email: "ops@example.com" }, {} as NodeJS.ProcessEnv), false);
  });
  it("matches listed ids or emails, case-insensitively", () => {
    assert.equal(isPlatformOperator({ id: "user_op" }, ENV), true);
    assert.equal(isPlatformOperator({ id: "u2", email: "OPS@example.com" }, ENV), true);
    assert.equal(isPlatformOperator({ id: "u3", email: "owner@tenant.com" }, ENV), false);
    assert.equal(isPlatformOperator(null, ENV), false);
  });
});

describe("requirePlatformOperator", () => {
  it("401 signed out, 403 for a tenant owner, ok for an operator", async () => {
    const out = await requirePlatformOperator(async () => null, ENV);
    assert.ok(out instanceof Response && out.status === 401);
    const owner = await requirePlatformOperator(async () => ({ id: "tenant_owner", email: "owner@tenant.com" }), ENV);
    assert.ok(owner instanceof Response && owner.status === 403);
    const op = await requirePlatformOperator(async () => ({ id: "user_op", email: null }), ENV);
    assert.deepEqual(op, { id: "user_op", email: null });
  });
});

describe("shared corpus + flow-binding mutations are operator-gated", () => {
  const routes = [
    "app/api/corpus/propose/route.ts",
    "app/api/corpus/remove/route.ts",
    "app/api/corpus/rebuild/route.ts",
    "app/api/integrations/activepieces/bindings/route.ts",
  ];
  for (const route of routes) {
    it(`${route}: every POST/DELETE starts with requirePlatformOperator()`, () => {
      const src = readFileSync(join(ROOT, route), "utf8");
      const handlers = [...src.matchAll(/export async function (POST|DELETE)\([^)]*\)[^{]*\{\n([^\n]*)/g)];
      assert.ok(handlers.length > 0, "has mutation handlers");
      for (const [, method, firstLine] of handlers) {
        assert.match(firstLine!, /await requirePlatformOperator\(\)/, `${method} must gate on platform operators first`);
      }
    });
  }
});
