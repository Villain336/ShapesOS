// ShapesOS — Phase 4a: GET /api/health against a real, fully migrated
// database, as the least-privilege app role (it must be able to read
// _prisma_migrations). Also checks the body stays free of anything an
// anonymous caller shouldn't learn.
// Run: DATABASE_URL=… npx tsx --test lib/observability/__tests__/health-db.test.ts

import "dotenv/config";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { checkMigrations, readiness, shippedMigrations } from "../health";
import { GET, HEAD } from "@/app/api/health/route";
import { GET as LIVE } from "@/app/api/health/live/route";

after(async () => {
  await prisma.$disconnect();
});

describe("GET /api/health (readiness)", () => {
  it("every shipped migration is applied on the test database", async () => {
    const shipped = shippedMigrations();
    assert.ok(shipped && shipped.length > 100, "the migrations folder is found from the repo root");
    const m = await checkMigrations();
    assert.deepEqual(m, { status: "ok", pending: 0, failed: 0 });
  });

  it("answers 200 with status ok, no-store, and nothing sensitive", async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as Awaited<ReturnType<typeof readiness>>;
    assert.equal(body.status, "ok");
    assert.equal(body.checks.database.status, "ok");
    assert.equal(typeof body.checks.database.latencyMs, "number");
    assert.equal(body.checks.migrations.pending, 0);
    assert.match(body.version, /^\d+\.\d+\.\d+/);
    assert.deepEqual(Object.keys(body).sort(), ["checks", "commit", "status", "time", "uptimeSeconds", "version"]);
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /postgres|localhost|password|DATABASE_URL|_prisma_migrations|\d{14}_/i);
  });

  it("HEAD mirrors the status without a body", async () => {
    const res = await HEAD();
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  it("liveness needs no database", async () => {
    const res = LIVE();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});
