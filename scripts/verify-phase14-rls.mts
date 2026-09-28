#!/usr/bin/env tsx
// Marketr — Phase 14 RLS battery (docs/phases/PHASE14-COMPOSIO-UNIVER-SPEC.md).
//
// Mirrors scripts/verify-phase13d-rls.mts for the four new Phase 14 tables:
//   composio_connections, composio_action_approvals, composio_action_logs,
//   univer_docs
//
// Covers per table: FORCE RLS on, fail-closed (no GUC → zero rows),
// cross-workspace read isolation, write-to-another-workspace blocked,
// unscoped UPDATE is a no-op.
//
// Usage: npx tsx scripts/verify-phase14-rls.mts
// Exits 1 on any failure.

import "dotenv/config";
import { prisma } from "../lib/prisma";
import {
  withWorkspaceScope,
  countWithoutScope,
} from "../lib/substrate/memory/rls";

// ---------------------------------------------------------------------------
// harness (mirrors scripts/verify-phase13d-rls.mts)
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(title: string) {
  console.log(`\n## ${title}`);
}

const WS_A = "14-battery-a";
const WS_B = "14-battery-b";

const ALL_TABLES = [
  "composio_connections",
  "composio_action_approvals",
  "composio_action_logs",
  "univer_docs",
] as const;

async function resetBatteryState() {
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `14 battery ${id}`, ownerUserId: "14-battery-owner" },
    });
  }
}

async function seedWorkspaceA() {
  await withWorkspaceScope(WS_A, async (tx) => {
    await tx.composioConnection.create({
      data: {
        workspaceId: WS_A,
        appKey: "gmail",
        composioEntityId: "entity_battery_a",
        status: "connected",
        scopes: ["gmail.read", "gmail.compose"],
      },
    });
    const approval = await tx.composioActionApproval.create({
      data: {
        workspaceId: WS_A,
        appKey: "gmail",
        toolName: "GMAIL_SEND_EMAIL",
        riskTier: "medium",
        proposedArgs: { to: ["[redacted]"], subject: "Battery" },
        plainSummary: "Send an email to 1 recipient with subject “Battery”.",
        status: "pending",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await tx.composioActionLog.create({
      data: {
        workspaceId: WS_A,
        approvalId: approval.id,
        appKey: "gmail",
        toolName: "GMAIL_LIST_MESSAGES",
        riskTier: "low",
        status: "success",
        executedBy: "agent:battery",
      },
    });
    await tx.univerDoc.create({
      data: {
        workspaceId: WS_A,
        kind: "sheet",
        title: "Battery report",
        snapshot: { id: "wb_battery", sheets: {} },
        sourceRef: "report:battery",
      },
    });
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  await resetBatteryState();
  await seedWorkspaceA();

  section("1. FORCE RLS on all new Phase 14 tables");
  const rls = (await prisma.$queryRawUnsafe(
    `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity,
            c.relforcerowsecurity AS force_rowsecurity
       FROM pg_class c
      WHERE c.relname = ANY($1)`,
    [...ALL_TABLES] as unknown as string[],
  )) as Array<{ tablename: string; rowsecurity: boolean; force_rowsecurity: boolean }>;
  check(
    `FORCE RLS on all ${ALL_TABLES.length} tables`,
    rls.length === ALL_TABLES.length &&
      rls.every((r) => r.rowsecurity && r.force_rowsecurity),
    rls.map((r) => `${r.tablename}:${r.force_rowsecurity ? "forced" : "off"}`).join(" "),
  );
  const policies = (await prisma.$queryRawUnsafe(
    `SELECT tablename, policyname FROM pg_policies WHERE tablename = ANY($1)`,
    [...ALL_TABLES] as unknown as string[],
  )) as Array<{ tablename: string; policyname: string }>;
  check(
    "tenant_isolation policy on all tables",
    policies.length === ALL_TABLES.length &&
      policies.every((p) => p.policyname === `${p.tablename}_tenant_isolation`),
    policies.map((p) => `${p.tablename}:${p.policyname}`).join(" "),
  );

  section("2. Fail-closed: no GUC → zero rows on every new table");
  for (const t of ALL_TABLES) {
    const n = await countWithoutScope(t);
    check(`no-GUC read on ${t} returns zero`, n === 0, `${n} rows`);
  }

  section("3. Cross-workspace read isolation");
  await withWorkspaceScope(WS_B, async (tx) => {
    const counts = {
      connections: await tx.composioConnection.count(),
      approvals: await tx.composioActionApproval.count(),
      logs: await tx.composioActionLog.count(),
      docs: await tx.univerDoc.count(),
    };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    check("workspace B sees ZERO rows from workspace A", total === 0, JSON.stringify(counts));
  });
  await withWorkspaceScope(WS_A, async (tx) => {
    const counts = {
      connections: await tx.composioConnection.count(),
      approvals: await tx.composioActionApproval.count(),
      logs: await tx.composioActionLog.count(),
      docs: await tx.univerDoc.count(),
    };
    const ok =
      counts.connections === 1 &&
      counts.approvals === 1 &&
      counts.logs === 1 &&
      counts.docs === 1;
    check("workspace A sees its own rows", ok, JSON.stringify(counts));
  });

  section("4. Write to another workspace is blocked (WITH CHECK)");
  const crossWriteAttempts: Array<[string, () => Promise<unknown>]> = [
    [
      "composio_connections",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.composioConnection.create({
            data: {
              workspaceId: WS_B,
              appKey: "slack",
              composioEntityId: "entity_x",
            },
          }),
        ),
    ],
    [
      "composio_action_approvals",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.composioActionApproval.create({
            data: {
              workspaceId: WS_B,
              appKey: "gmail",
              toolName: "GMAIL_SEND_EMAIL",
              riskTier: "medium",
              proposedArgs: {},
              plainSummary: "x",
              expiresAt: new Date(Date.now() + 3600_000),
            },
          }),
        ),
    ],
    [
      "composio_action_logs",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.composioActionLog.create({
            data: {
              workspaceId: WS_B,
              appKey: "gmail",
              toolName: "GMAIL_LIST_MESSAGES",
              riskTier: "low",
              status: "success",
              executedBy: "agent:x",
            },
          }),
        ),
    ],
    [
      "univer_docs",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.univerDoc.create({
            data: {
              workspaceId: WS_B,
              kind: "sheet",
              title: "x",
              snapshot: {},
            },
          }),
        ),
    ],
  ];
  for (const [label, attempt] of crossWriteAttempts) {
    let blocked = false;
    let detail = "";
    try {
      await attempt();
    } catch (e) {
      blocked = /row-level security/i.test((e as Error).message);
      detail = (e as Error).message.slice(0, 90);
    }
    check(`cross-workspace INSERT into ${label} blocked`, blocked, detail);
  }

  section("5. Unscoped UPDATE is a no-op (fail-closed on writes too)");
  const updated = (await prisma.$executeRawUnsafe(
    `UPDATE "composio_connections" SET "status" = 'revoked'`,
  )) as unknown as number;
  check("unscoped UPDATE touches zero rows", updated === 0, `${updated} rows`);
  await withWorkspaceScope(WS_A, async (tx) => {
    const row = await tx.composioConnection.findFirst({ where: { status: "connected" } });
    check("connection row intact after unscoped UPDATE attempt", row !== null);
  });

  section("6. Defaults behave");
  await withWorkspaceScope(WS_A, async (tx) => {
    const conn = await tx.composioConnection.create({
      data: { workspaceId: WS_A, appKey: "notion", composioEntityId: "entity_n" },
    });
    check(
      "connection defaults (connected/[]) ",
      conn.status === "connected" && JSON.stringify(conn.scopes) === "[]",
      `${conn.status}/${JSON.stringify(conn.scopes)}`,
    );
    await tx.composioConnection.delete({ where: { id: conn.id } });
    const doc = await tx.univerDoc.create({
      data: { workspaceId: WS_A, kind: "doc", title: "defaults", snapshot: {} },
    });
    check(
      "univer doc defaults (v1/private)",
      doc.version === 1 && doc.shareState === "private",
      `v${doc.version}/${doc.shareState}`,
    );
    await tx.univerDoc.delete({ where: { id: doc.id } });
  });

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed` +
      (failed.length ? " — FAILURES ABOVE" : ""),
  );
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
