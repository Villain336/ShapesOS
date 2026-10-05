// ShapesOS — Phase 8: the shared SKIP LOCKED claim statement (PURE).
// Run: env -u DATABASE_URL npx tsx --test lib/jobs/__tests__/claim.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { claimRowsSql } from "../claim";

describe("claimRowsSql", () => {
  it("one UPDATE over a FOR UPDATE SKIP LOCKED sub-select, workspace-bound, values parameterised", () => {
    const sql = claimRowsSql({
      workspaceId: "ws'; DROP TABLE x; --",
      table: "clip_jobs",
      where: Prisma.sql`sub."status" = ${"pending"}`,
      orderBy: Prisma.sql`sub."created_at" ASC`,
      set: Prisma.sql`"status" = 'processing'`,
      returning: Prisma.sql`"id"`,
      limit: 3,
    });
    const text = sql.text.replace(/\s+/g, " ");
    assert.match(text, /UPDATE "clip_jobs" SET "status" = 'processing' WHERE "id" IN \( SELECT sub\."id" FROM "clip_jobs" AS sub WHERE sub\."workspace_id" = \$1 AND \(sub\."status" = \$2\) ORDER BY sub\."created_at" ASC FOR UPDATE SKIP LOCKED LIMIT \$3\) RETURNING "id"/);
    assert.deepEqual(sql.values, ["ws'; DROP TABLE x; --", "pending", 3]);
  });

  it("refuses a table name that is not a plain identifier", () => {
    assert.throws(() =>
      claimRowsSql({ workspaceId: "w", table: 'x"; drop', where: Prisma.empty, orderBy: Prisma.sql`1`, set: Prisma.sql`a = 1`, returning: Prisma.sql`id` }),
    );
  });
});
