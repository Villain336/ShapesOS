// ShapesOS — Phase 10 (finance): company expense claims on real Postgres
// (app role), through the REAL Phase 14 gate:
//   - receipts must be this workspace's WorkspaceFiles; drafts are edited by
//     the claimant only
//   - submit proposes OPS_EXPENSE_APPROVE as the claimant → the claimant
//     can't approve it (separation of duties), the owner can
//   - executing the approval posts Dr Expense (+ input tax) / Cr
//     Reimbursements payable; replay blocked
//   - reimburse is gated and posts Dr Reimbursements payable / Cr Cash
//   - the personal WFH tracker tables are untouched
// Run (DB suite): DATABASE_URL=… npx tsx --test lib/ops/__tests__/finance-expenses-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { decideApproval, SeparationOfDutiesError } from "@/lib/integrations/actions/gate";
import { OPS_ENTITY_MAP } from "../entities";
import { opsCreate, opsPatch, OpsError, type OpsActor } from "../doctype";
import { OpsGateError } from "../gate";
import { findEntryBySource } from "../accounting";
import { approveExpenseClaim, reimburseExpenseClaim, rejectExpenseClaim, submitExpenseClaim } from "../finance/expenses";

const WS = "p10fin-exp";
const OWNER = "user_p10fin_owner";
const CLAIMANT: OpsActor = { workspaceId: WS, userId: "user_p10fin_claimant" };
const OWNER_ACTOR: OpsActor = { workspaceId: WS, userId: OWNER };
const CLAIMS = OPS_ENTITY_MAP["expense-claims"]!;
const rowOf = (r: unknown) => (r as { row: Record<string, unknown> }).row;
let receiptId = "";

before(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${WS}, ${WS}, ${OWNER}, now())`;
  receiptId = await withWorkspaceScope(WS, (tx) =>
    tx.workspaceFile.create({
      data: { workspaceId: WS, logicalPath: "/files/receipts/taxi.pdf", storageKey: `p10fin-${Date.now()}`, filename: "taxi.pdf", mimeType: "application/pdf", sizeBytes: 10, kind: "file", createdBy: CLAIMANT.userId },
    }),
  ).then((f) => f.id);
});

after(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$disconnect();
});

const LINES = [
  { spentAt: "2026-10-01", description: "Taxi to client", category: "travel", amountCents: 6_000, taxCents: 1_000, receiptFileId: "" },
  { spentAt: "2026-10-01", description: "Lunch with client", category: "meals", amountCents: 4_500 },
];

describe("expense claims", () => {
  it("drafts with receipts from Files; edits are claimant-only", async () => {
    const lines = LINES.map((l) => ({ ...l, ...(l.receiptFileId === "" ? { receiptFileId: receiptId } : {}) }));
    await assert.rejects(
      withWorkspaceScope(WS, (tx) => opsCreate(tx, CLAIMS, CLAIMANT, { title: "Client visit", lines: [{ ...lines[0], receiptFileId: "not-a-file" }] })),
      /receipt file/,
    );
    const claim = rowOf(await withWorkspaceScope(WS, (tx) => opsCreate(tx, CLAIMS, CLAIMANT, { title: "Client visit", lines })));
    assert.equal(claim.totalCents, 10_500);
    assert.equal(claim.status, "draft");
    await assert.rejects(
      withWorkspaceScope(WS, (tx) => opsPatch(tx, CLAIMS, OWNER_ACTOR, { id: claim.id, title: "Hijack" })),
      (e: unknown) => e instanceof OpsError && e.status === 403,
    );
    const edited = rowOf(await withWorkspaceScope(WS, (tx) => opsPatch(tx, CLAIMS, CLAIMANT, { id: claim.id, lines: [...lines, { spentAt: "2026-10-02", description: "Parking", category: "travel", amountCents: 1_500 }] })));
    assert.equal(edited.totalCents, 12_000);
  });

  it("submit → separation of duties → approve posts → reimburse (gated) posts", async () => {
    const claim = rowOf(await withWorkspaceScope(WS, (tx) => opsCreate(tx, CLAIMS, CLAIMANT, { title: "Conference", lines: [{ spentAt: "2026-10-03", description: "Ticket", category: "software", amountCents: 20_000, taxCents: 2_000 }] })));
    const id = String(claim.id);
    await assert.rejects(withWorkspaceScope(WS, (tx) => submitExpenseClaim(tx, OWNER_ACTOR, id)), /Only the claimant/);
    const { approval, number } = await withWorkspaceScope(WS, (tx) => submitExpenseClaim(tx, CLAIMANT, id));
    assert.match(number, /^EXP-\d{4}$/);

    // Executing before anyone approved fails closed.
    await assert.rejects(withWorkspaceScope(WS, (tx) => approveExpenseClaim(tx, OWNER_ACTOR, id, approval.id)), (e: unknown) => e instanceof OpsGateError);
    // The claimant can't approve their own claim while another approver exists.
    await assert.rejects(decideApproval({ workspaceId: WS, approvalId: approval.id, decision: "approved", decidedBy: CLAIMANT.userId }), SeparationOfDutiesError);
    await decideApproval({ workspaceId: WS, approvalId: approval.id, decision: "approved", decidedBy: OWNER });

    const r = await withWorkspaceScope(WS, (tx) => approveExpenseClaim(tx, OWNER_ACTOR, id, approval.id));
    assert.equal(r.status, "approved");
    await assert.rejects(withWorkspaceScope(WS, (tx) => approveExpenseClaim(tx, OWNER_ACTOR, id, approval.id)), /Only a submitted claim/);
    const posted = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `expense:${id}:approve`));
    const byCode = Object.fromEntries(posted!.lines.map((l) => [l.accountCode, l.debitCents || -l.creditCents]));
    assert.deepEqual(byCode, { "6200": 18_000, "1300": 2_000, "2200": -20_000 });

    const proposed = await withWorkspaceScope(WS, (tx) => reimburseExpenseClaim(tx, OWNER_ACTOR, id, undefined));
    assert.equal(proposed.outcome, "approval_required");
    const reimburseApproval = (proposed as { approval: { id: string } }).approval.id;
    await decideApproval({ workspaceId: WS, approvalId: reimburseApproval, decision: "approved", decidedBy: OWNER });
    const done = await withWorkspaceScope(WS, (tx) => reimburseExpenseClaim(tx, OWNER_ACTOR, id, reimburseApproval));
    assert.equal(done.outcome, "done");
    const paid = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `expense:${id}:reimburse`));
    const byCode2 = Object.fromEntries(paid!.lines.map((l) => [l.accountCode, l.debitCents || -l.creditCents]));
    assert.deepEqual(byCode2, { "2200": 20_000, "1000": -20_000 });
  });

  it("a reviewer can reject a submitted claim with a reason", async () => {
    const claim = rowOf(await withWorkspaceScope(WS, (tx) => opsCreate(tx, CLAIMS, CLAIMANT, { title: "Gadget", lines: [{ spentAt: "2026-10-03", description: "Headphones", category: "office", amountCents: 30_000 }] })));
    const id = String(claim.id);
    await withWorkspaceScope(WS, (tx) => submitExpenseClaim(tx, CLAIMANT, id));
    const r = await withWorkspaceScope(WS, (tx) => rejectExpenseClaim(tx, OWNER_ACTOR, id, "Personal purchase"));
    assert.equal(r.status, "rejected");
    const row = await withWorkspaceScope(WS, (tx) => tx.opsExpenseClaim.findFirstOrThrow({ where: { id } }));
    assert.equal(row.rejectedReason, "Personal purchase");
    const posted = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `expense:${id}:approve`));
    assert.equal(posted, null, "a rejected claim posts nothing");
  });
});
