// ShapesOS — Phase 17 (latency): DATABASE_POOL_SIZE → Prisma's connection_limit (PURE).
// Run: env -u DATABASE_URL npx tsx --test lib/__tests__/prisma-pool.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pooledDatabaseUrl } from "../prisma";

describe("pooledDatabaseUrl", () => {
  it("applies the pool size when the URL has none", () => {
    assert.equal(pooledDatabaseUrl({ DATABASE_URL: "postgresql://u:p@h:5432/db", DATABASE_POOL_SIZE: "8" }), "postgresql://u:p@h:5432/db?connection_limit=8");
    assert.equal(pooledDatabaseUrl({ DATABASE_URL: "postgresql://u:p@h/db?schema=public", DATABASE_POOL_SIZE: "12" }), "postgresql://u:p@h/db?schema=public&connection_limit=12");
  });
  it("leaves Prisma's default when unset, invalid, or already in the URL", () => {
    assert.equal(pooledDatabaseUrl({ DATABASE_URL: "postgresql://h/db" }), null);
    assert.equal(pooledDatabaseUrl({ DATABASE_URL: "postgresql://h/db", DATABASE_POOL_SIZE: "zero" }), null);
    assert.equal(pooledDatabaseUrl({ DATABASE_URL: "postgresql://h/db", DATABASE_POOL_SIZE: "0" }), null);
    assert.equal(pooledDatabaseUrl({ DATABASE_URL: "postgresql://h/db?connection_limit=3", DATABASE_POOL_SIZE: "8" }), null);
    assert.equal(pooledDatabaseUrl({ DATABASE_POOL_SIZE: "8" }), null);
  });
});
