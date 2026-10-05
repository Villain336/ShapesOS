// ShapesOS — FORCE-RLS tables under the least-privilege app role.
//
// Phase 1 moved the app off the Postgres superuser (which bypasses RLS) onto a
// NOSUPERUSER/NOBYPASSRLS role. Any query on a FORCE-RLS table that does not
// set app.workspace_id then sees ZERO rows — so code that used the plain
// client (report send approvals, mission lookups, the fleet cron) silently
// broke. This suite:
//   1. proves scopedDb() lets client-shaped code (lib/reports/report-gate.ts)
//      work under RLS while a plain unscoped read sees nothing, and
//   2. guards the codebase: no `prisma.<model>.` call may target a FORCE-RLS
//      table outside a workspace scope. The FORCE-RLS table list is read from
//      the live, fully migrated database, so new RLS tables are covered.
// Run (DB suite, as the app role): DATABASE_URL=… npx tsx --test lib/substrate/memory/__tests__/rls-least-privilege-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { scopedDb, withWorkspaceScope } from "../rls";
import { denyReportSend, draftReportSend } from "@/lib/reports/report-gate";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const WS = `rls-lp-${randomUUID().slice(0, 8)}`;

// Reviewed exceptions: unscoped reads that RLS policy deliberately allows.
const ALLOWED = new Set([
  // playbook_learnings_reviewed_read permits reviewed rows without a tenant
  // GUC (the shared, reviewed playbook library).
  "lib/substrate/memory/playbook.ts playbookLearning",
]);

before(async () => {
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
    VALUES (${WS}, ${WS}, ${"test:" + WS}, now()) ON CONFLICT DO NOTHING`;
});

after(async () => {
  // Best-effort cleanup (audit rows may pin the workspace).
  await withWorkspaceScope(WS, (tx) => tx.reportSendApproval.deleteMany({ where: { workspaceId: WS } })).catch(() => {});
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`.catch(() => {});
  await prisma.$disconnect();
});

describe("FORCE-RLS under the least-privilege role", () => {
  it("report gate works through scopedDb; an unscoped read sees nothing", async () => {
    const db = scopedDb(WS);
    const row = await draftReportSend(db, {
      workspaceId: WS,
      createdBy: "user-1",
      templateName: "client-performance",
      templateVersion: "1.0.0",
      clientName: "RLS Client",
      period: "September 2026",
      figures: [
        { key: "organic_sessions", label: "Organic sessions", value: "12,480", source: { provider: "dataforseo", ref: "job-1" } },
      ],
    });
    assert.equal(row.status, "pending");

    // The plain client has no tenant GUC: FORCE RLS hides the row (unless the
    // suite is mistakenly run as a superuser — then this proves nothing).
    const role = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (!role[0].rolsuper && !role[0].rolbypassrls) {
      const unscoped = await prisma.reportSendApproval.findFirst({ where: { id: row.id } });
      assert.equal(unscoped, null, "unscoped read must see zero rows under RLS");
    }

    await denyReportSend(db, { workspaceId: WS, id: row.id, actor: "user-2", note: "no" });
    const after = await withWorkspaceScope(WS, (tx) => tx.reportSendApproval.findFirst({ where: { id: row.id } }));
    assert.equal(after?.status, "denied");
  });

  it("no plain prisma.<model> call targets a FORCE-RLS table", async () => {
    const tables = new Set(
      (
        await prisma.$queryRaw<Array<{ relname: string }>>`
          SELECT relname FROM pg_class WHERE relforcerowsecurity`
      ).map((r) => r.relname),
    );
    assert.ok(tables.size > 0, "expected FORCE-RLS tables in a migrated DB");

    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    const accessors = new Map<string, string>();
    for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const table = /@@map\("([^"]+)"\)/.exec(m[2])?.[1] ?? m[1];
      if (tables.has(table)) accessors.set(m[1][0].toLowerCase() + m[1].slice(1), table);
    }

    const files = execFileSync("git", ["ls-files", "app", "lib", "components", "auth.ts"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const accessor of accessors.keys()) {
        const re = new RegExp(`\\bprisma\\.${accessor}\\.\\w+\\(`, "g");
        for (const hit of src.matchAll(re)) {
          if (ALLOWED.has(`${f} ${accessor}`)) continue;
          const line = src.slice(0, hit.index).split("\n").length;
          offenders.push(`${f}:${line} prisma.${accessor} (${accessors.get(accessor)})`);
        }
      }
    }
    assert.deepEqual(offenders, [], "use withWorkspaceScope/scopedDb for FORCE-RLS tables");
  });
});
