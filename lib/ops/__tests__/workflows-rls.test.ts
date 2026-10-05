// Marketr — Phase 17 slice 6 tests: RLS isolation + runKey replay lock on
// ops_workflow_runs (scratch DB). Integration: hits the scratch Postgres DB
// (ops_slice1_scratch) carrying the phase-17 ops migrations, exercising the
// same withWorkspaceScope code paths the DocType service uses.
// Run with DATABASE_URL pointing at the scratch DB:
//   npx tsx --test lib/ops/__tests__/workflows-rls.test.ts
// Requires the phase-17 migrations (incl. phase17_workflow_runkey) applied.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

const WS_A = "17s6-ws-a";
const WS_B = "17s6-ws-b";

async function createWorkspace(id: string) {
  // Targets the fully migrated schema (scripts/db/migrate.sh).
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
    VALUES (${id}, ${id}, ${"test:" + id}, now()) ON CONFLICT DO NOTHING`;
}

async function deleteWorkspace(id: string) {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
}

before(async () => {
  for (const id of [WS_A, WS_B]) await createWorkspace(id);
});

after(async () => {
  for (const id of [WS_A, WS_B]) await deleteWorkspace(id);
  await prisma.$disconnect();
});

describe("workflow-runs RLS + runKey replay lock (scratch DB)", () => {
  it("isolates runs across workspaces: A writes, B sees nothing", async () => {
    const created = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsWorkflowRun.create({
        data: {
          workspaceId: WS_A,
          workflowName: "order-payment-fulfillment",
          runKey: "17s6-iso-a",
          steps: [],
          status: "succeeded",
        },
      }),
    );
    assert.ok(created.id);

    const seenB = await withWorkspaceScope(WS_B, (tx) =>
      tx.opsWorkflowRun.findMany({ where: { workspaceId: WS_A } }),
    );
    assert.equal(seenB.length, 0, "workspace B must not see A's workflow runs");

    const seenA = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsWorkflowRun.findMany({ where: { workspaceId: WS_A, runKey: "17s6-iso-a" } }),
    );
    assert.equal(seenA.length, 1);
  });

  it("is invisible without the GUC (fail-closed)", async () => {
    const rows = await prisma.opsWorkflowRun.findMany();
    assert.equal(rows.length, 0, "workflow runs must be invisible without the workspace GUC");
  });

  it("rejects a duplicate runKey in the same workspace (replay lock)", async () => {
    await withWorkspaceScope(WS_A, (tx) =>
      tx.opsWorkflowRun.create({
        data: {
          workspaceId: WS_A,
          workflowName: "order-payment-fulfillment",
          runKey: "17s6-replay",
          steps: [],
          status: "running",
        },
      }),
    );
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) =>
        tx.opsWorkflowRun.create({
          data: {
            workspaceId: WS_A,
            workflowName: "order-payment-fulfillment",
            runKey: "17s6-replay",
            steps: [],
            status: "running",
          },
        }),
      ),
      (e: unknown) => {
        assert.equal((e as { code?: string }).code, "P2002");
        return true;
      },
    );
  });

  it("allows the same runKey in a different workspace", async () => {
    const row = await withWorkspaceScope(WS_B, (tx) =>
      tx.opsWorkflowRun.create({
        data: {
          workspaceId: WS_B,
          workflowName: "order-payment-fulfillment",
          runKey: "17s6-replay",
          steps: [],
          status: "running",
        },
      }),
    );
    assert.ok(row.id);
  });
});
