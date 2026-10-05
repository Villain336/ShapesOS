// ShapesOS Phase 10 (ops-core): HR on real Postgres — approving leave
// deducts once (gate executed via a stub-approved port) and refuses to
// overdraw; hiring an applicant creates one team member; team-member user
// links must be workspace members; RLS on the new HR tables.
// Run as the app role (scripts/test/db-tests.txt):
//   DATABASE_URL=<app role url> npx tsx --test lib/ops/__tests__/p10-hr-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsCreate, opsPatch, type OpsActor } from "../doctype";
import { opsBindingFor, type OpsGatePort } from "../gate";
import { leaveBalanceFor } from "../leave";

const WS = "p10hr-ws-a";
const WS_B = "p10hr-ws-b";
const ANN = "user-p10hr-ann";
const A: OpsActor = { workspaceId: WS, userId: ANN };
const def = (slug: string) => OPS_ENTITY_MAP[slug]!;
const inA = <T>(fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(WS, fn);
const row = (r: unknown) => (r as { row: Record<string, unknown> }).row;

/** Approval port STUB: approves exactly the mutation it is asked about. */
function approvedPort(entityId: string, mutation: Record<string, unknown>): OpsGatePort {
  return {
    propose: async () => ({ id: "ap", status: "pending", riskTier: "medium" }),
    getApproval: async (_ws, id) => ({
      id,
      status: "approved",
      expiresAt: new Date(Date.now() + 3600_000),
      proposedArgs: opsBindingFor({ entity: "leave-requests", entityId, slug: "OPS_LEAVE_APPROVE", mutation }),
    }),
  };
}

let memberId = "";

before(async () => {
  for (const id of [WS, WS_B]) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${"test:" + id}, now())`;
  }
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: ANN, name: "Ann", role: "owner" } });
  memberId = String(row(await inA((tx) => opsCreate(tx, def("team-members"), A, { name: "Ann", userId: ANN, startDate: "2025-01-01" }))).id);
  await inA((tx) => opsCreate(tx, def("leave-policies"), A, { type: "vacation", yearlyDays: 12, carryOverCapDays: 0 }));
});

after(async () => {
  for (const id of [WS, WS_B]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$disconnect();
});

async function approve(requestId: string) {
  // ops_composio approvals are real rows; the claim needs one in the table.
  const mutation = { id: requestId, status: "approved" };
  const approval = await inA((tx) =>
    tx.composioActionApproval.create({
      data: {
        workspaceId: WS,
        appKey: "ops",
        toolName: "OPS_LEAVE_APPROVE",
        riskTier: "medium",
        status: "approved",
        proposedArgs: opsBindingFor({ entity: "leave-requests", entityId: requestId, slug: "OPS_LEAVE_APPROVE", mutation }) as object,
        plainSummary: "test",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    }),
  );
  return inA((tx) => opsPatch(tx, def("leave-requests"), A, { ...mutation, approvalId: approval.id }, { gatePort: approvedPort(requestId, mutation) }));
}

describe("p10 HR (real Postgres, app role)", () => {
  it("team-member user links must be workspace members", async () => {
    await assert.rejects(
      inA((tx) => opsCreate(tx, def("team-members"), A, { name: "Ghost", userId: "not-a-member" })),
      (e: unknown) => e instanceof OpsError && e.status === 422,
    );
  });

  it("approving leave deducts working days once; overdraw is refused", async () => {
    // Mon 2026-03-02 … Fri 2026-03-06 = 5 working days; 12/yr accrued by March = 3 + 2025 carry 0.
    const req = row(await inA((tx) => opsCreate(tx, def("leave-requests"), A, { memberId, type: "vacation", startDate: "2026-03-02", endDate: "2026-03-06" })));
    await assert.rejects(approve(String(req.id)), (e: unknown) => e instanceof OpsError && e.status === 422, "3 days accrued < 5 requested");
    const small = row(await inA((tx) => opsCreate(tx, def("leave-requests"), A, { memberId, type: "vacation", startDate: "2026-03-02", endDate: "2026-03-03" })));
    const r = await approve(String(small.id));
    assert.equal(r.outcome, "done");
    const ledger = await inA((tx) => tx.opsLeaveLedger.findMany({ where: { memberId } }));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.centidays, 200);
    const bal = await inA((tx) => leaveBalanceFor(tx, WS, memberId, "vacation", new Date("2026-03-15T00:00:00Z")));
    assert.equal(bal?.available, 300 - 200);
  });

  it("hiring an applicant creates exactly one team member", async () => {
    const dept = row(await inA((tx) => opsCreate(tx, def("departments"), A, { name: "Engineering" })));
    const opening = row(await inA((tx) => opsCreate(tx, def("job-openings"), A, { title: "Engineer", departmentId: dept.id })));
    const app = row(await inA((tx) => opsCreate(tx, def("applicants"), A, { openingId: opening.id, name: "Linus", email: "linus@example.test" })));
    const hired = row(await inA((tx) => opsPatch(tx, def("applicants"), A, { id: app.id, stage: "hired" })));
    assert.ok(hired.hiredMemberId);
    const m = await inA((tx) => tx.opsTeamMember.findFirst({ where: { id: String(hired.hiredMemberId) } }));
    assert.equal(m?.departmentId, dept.id);
    assert.equal(m?.title, "Engineer");
    await inA((tx) => opsPatch(tx, def("applicants"), A, { id: app.id, stage: "hired" }));
    assert.equal(await inA((tx) => tx.opsTeamMember.count({ where: { name: "Linus" } })), 1);
  });

  it("RLS: another workspace sees none of the HR rows", async () => {
    const counts = await withWorkspaceScope(WS_B, async (tx) => [
      await tx.opsDepartment.count({ where: { workspaceId: WS } }),
      await tx.opsLeavePolicy.count({ where: { workspaceId: WS } }),
      await tx.opsLeaveLedger.count({ where: { workspaceId: WS } }),
      await tx.opsJobOpening.count({ where: { workspaceId: WS } }),
      await tx.opsApplicant.count({ where: { workspaceId: WS } }),
    ]);
    assert.deepEqual(counts, [0, 0, 0, 0, 0]);
    const raw = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM ops_leave_ledger`;
    assert.equal(Number(raw[0]!.n), 0, "no GUC → zero rows");
  });
});
