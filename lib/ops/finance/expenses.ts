// ShapesOS — Phase 10 (finance): company expense claims.
//
// NOT the personal WFH deduction tracker (lib/wfh/expenses.ts stays separate
// and untouched). A claim is a member's out-of-pocket spend on the company:
//
//   draft      the claimant adds lines (date, category, amount, recoverable
//              tax, receipt = a WorkspaceFile uploaded via POST /api/files)
//   submitted  numbered EXP-0001; an OPS_EXPENSE_APPROVE approval is
//              proposed BY THE CLAIMANT — the Phase 14 decide step enforces
//              separation of duties (the requester can't approve their own
//              claim while another approver exists)
//   approved   executing the approved approval posts Dr Expense (+ input
//              tax) / Cr Reimbursements payable
//   rejected   a reviewer's decision (free, logged), with a reason
//   reimbursed gated OPS_EXPENSE_REIMBURSE; Dr Reimbursements payable / Cr Cash

import type { Prisma } from "@prisma/client";
import { OpsError, type OpsActor } from "../doctype";
import { phase14GatePort, requestOpsApproval, verifyAndConsumeOpsApproval, type OpsGatePort, type OpsGateProposal } from "../gate";
import { EXPENSE_CATEGORIES } from "../accounting/rules";
import { fmtMoney } from "./money";
import { nextDocumentNumber } from "./numbering";
import { postExpenseApproved, postExpenseReimbursed } from "./posting";

type Tx = Prisma.TransactionClient;

export const EXPENSE_CATEGORY_LIST = Object.keys(EXPENSE_CATEGORIES);

export interface ExpenseLineInput {
  spentAt: string | Date;
  description: string;
  category: string;
  accountId?: string | null;
  amountCents: number;
  taxCents?: number;
  receiptFileId?: string | null;
}

/** Validate lines (PURE): categories, tax within amount, a positive total. */
export function validateExpenseLines(lines: ExpenseLineInput[]): { totalCents: number } {
  if (lines.length === 0) throw new OpsError(400, "Add at least one expense line");
  let total = 0;
  for (const [i, l] of lines.entries()) {
    if (!EXPENSE_CATEGORY_LIST.includes(l.category)) throw new OpsError(400, `Line ${i + 1}: unknown category "${l.category}"`);
    if (!Number.isInteger(l.amountCents) || l.amountCents <= 0) throw new OpsError(400, `Line ${i + 1}: the amount must be positive whole cents`);
    const tax = l.taxCents ?? 0;
    if (!Number.isInteger(tax) || tax < 0 || tax > l.amountCents) throw new OpsError(400, `Line ${i + 1}: tax must be between 0 and the amount`);
    if (Number.isNaN(new Date(l.spentAt).getTime())) throw new OpsError(400, `Line ${i + 1}: invalid date`);
    total += l.amountCents;
  }
  if (total > 2_147_483_647) throw new OpsError(400, "Claim total exceeds the maximum");
  return { totalCents: total };
}

async function assertRefs(tx: Tx, workspaceId: string, lines: ExpenseLineInput[]) {
  const files = [...new Set(lines.map((l) => l.receiptFileId).filter((x): x is string => Boolean(x)))];
  if (files.length) {
    const n = await tx.workspaceFile.count({ where: { workspaceId, id: { in: files }, trashedAt: null } });
    if (n !== files.length) throw new OpsError(400, "A receipt file isn't in this workspace (upload it via Files first)");
  }
  const accounts = [...new Set(lines.map((l) => l.accountId).filter((x): x is string => Boolean(x)))];
  if (accounts.length) {
    const n = await tx.opsAccount.count({ where: { workspaceId, id: { in: accounts }, type: "expense" } });
    if (n !== accounts.length) throw new OpsError(400, "Expense lines can only post to expense accounts");
  }
}

function lineData(workspaceId: string, claimId: string, l: ExpenseLineInput) {
  return {
    workspaceId,
    claimId,
    spentAt: new Date(l.spentAt),
    description: l.description.slice(0, 500),
    category: l.category,
    accountId: l.accountId ?? null,
    amountCents: l.amountCents,
    taxCents: l.taxCents ?? 0,
    receiptFileId: l.receiptFileId ?? null,
  };
}

export async function createExpenseClaim(tx: Tx, actor: OpsActor, input: { title: string; notes?: string | null; lines: ExpenseLineInput[]; claimantName?: string | null }) {
  const { totalCents } = validateExpenseLines(input.lines);
  await assertRefs(tx, actor.workspaceId, input.lines);
  // Display name at claim time, from the workspace membership.
  const member = input.claimantName
    ? null
    : await tx.workspaceMember.findFirst({ where: { workspaceId: actor.workspaceId, userId: actor.userId }, select: { name: true, email: true } });
  const claim = await tx.opsExpenseClaim.create({
    data: {
      workspaceId: actor.workspaceId,
      claimantId: actor.userId,
      claimantName: input.claimantName ?? member?.name ?? member?.email ?? null,
      title: input.title.slice(0, 200),
      notes: input.notes ?? null,
      totalCents,
      status: "draft",
    },
  });
  await tx.opsExpenseLine.createMany({ data: input.lines.map((l) => lineData(actor.workspaceId, claim.id, l)) });
  return claim;
}

/** Replace a draft claim's lines (claimant edits before submitting). */
export async function replaceExpenseLines(tx: Tx, actor: OpsActor, claimId: string, lines: ExpenseLineInput[]): Promise<number> {
  const { totalCents } = validateExpenseLines(lines);
  await assertRefs(tx, actor.workspaceId, lines);
  await tx.opsExpenseLine.deleteMany({ where: { workspaceId: actor.workspaceId, claimId } });
  await tx.opsExpenseLine.createMany({ data: lines.map((l) => lineData(actor.workspaceId, claimId, l)) });
  return totalCents;
}

async function loadClaim(tx: Tx, workspaceId: string, id: string) {
  const c = await tx.opsExpenseClaim.findFirst({ where: { id, workspaceId }, include: { lines: { orderBy: { spentAt: "asc" } } } });
  if (!c) throw new OpsError(404, `expense-claims "${id}" not found in workspace`);
  return c;
}

async function audit(tx: Tx, actor: OpsActor, id: string, action: string, summary: string) {
  await tx.opsAuditEvent.create({ data: { workspaceId: actor.workspaceId, entity: "expense-claims", entityId: id, action, actor: actor.userId, summary: summary.slice(0, 2000) } });
}

const approveBinding = (id: string, totalCents: number) => ({ id, approve: true, totalCents });
const reimburseBinding = (id: string, totalCents: number) => ({ id, reimburse: true, totalCents });

/** Submit for approval: number + status + an OPS_EXPENSE_APPROVE proposal from the claimant. */
export async function submitExpenseClaim(tx: Tx, actor: OpsActor, id: string, port: OpsGatePort = phase14GatePort): Promise<{ approval: OpsGateProposal; number: string }> {
  const c = await loadClaim(tx, actor.workspaceId, id);
  if (c.status !== "draft") throw new OpsError(422, `Only a draft claim can be submitted (it is ${c.status})`);
  if (c.claimantId !== actor.userId) throw new OpsError(403, "Only the claimant can submit their own claim");
  if (c.lines.length === 0 || c.totalCents <= 0) throw new OpsError(422, "Add at least one expense line before submitting");
  const number = c.number ?? (await nextDocumentNumber(tx, actor.workspaceId, "expense"));
  const approval = await requestOpsApproval(port, {
    workspaceId: actor.workspaceId,
    slug: "OPS_EXPENSE_APPROVE",
    entity: "expense-claims",
    entityId: id,
    mutation: approveBinding(id, c.totalCents),
    actor: actor.userId,
    summary: `Approve expense claim ${number} "${c.title}" — ${fmtMoney(c.totalCents)} over ${c.lines.length} line(s)${c.claimantName ? ` by ${c.claimantName}` : ""}`,
  });
  const moved = await tx.opsExpenseClaim.updateMany({
    where: { id, workspaceId: actor.workspaceId, status: "draft" },
    data: { status: "submitted", number, submittedAt: new Date(), approvalId: approval.id },
  });
  if (moved.count !== 1) throw new OpsError(409, "The claim changed concurrently — reload");
  await audit(tx, actor, id, "submit", `submitted ${number} (${fmtMoney(c.totalCents)}); approval ${approval.id} proposed`);
  return { approval, number };
}

/** Execute an approved OPS_EXPENSE_APPROVE: approve + post. */
export async function approveExpenseClaim(tx: Tx, actor: OpsActor, id: string, approvalId: string | null | undefined, port: OpsGatePort = phase14GatePort) {
  const c = await loadClaim(tx, actor.workspaceId, id);
  if (c.status !== "submitted") throw new OpsError(422, `Only a submitted claim can be approved (it is ${c.status})`);
  await verifyAndConsumeOpsApproval(port, tx, {
    workspaceId: actor.workspaceId,
    slug: "OPS_EXPENSE_APPROVE",
    entity: "expense-claims",
    entityId: id,
    mutation: approveBinding(id, c.totalCents),
    approvalId,
    actor: actor.userId,
  });
  const moved = await tx.opsExpenseClaim.updateMany({
    where: { id, workspaceId: actor.workspaceId, status: "submitted" },
    data: { status: "approved", decidedBy: actor.userId, decidedAt: new Date() },
  });
  if (moved.count !== 1) throw new OpsError(409, "The claim changed concurrently — reload");
  const posted = await postExpenseApproved(tx, actor, { id, number: c.number, title: c.title }, c.lines);
  await audit(tx, actor, id, "gate_executed", `approved ${c.number ?? id} (approval ${approvalId}); posted ${posted?.entry.id ?? "nothing"}`);
  return { status: "approved" as const, entryId: posted?.entry.id ?? null };
}

export async function rejectExpenseClaim(tx: Tx, actor: OpsActor, id: string, reason: string) {
  const c = await loadClaim(tx, actor.workspaceId, id);
  if (c.status !== "submitted") throw new OpsError(422, `Only a submitted claim can be rejected (it is ${c.status})`);
  const why = reason.trim().slice(0, 500);
  if (!why) throw new OpsError(400, "Say why the claim is rejected");
  const moved = await tx.opsExpenseClaim.updateMany({
    where: { id, workspaceId: actor.workspaceId, status: "submitted" },
    data: { status: "rejected", decidedBy: actor.userId, decidedAt: new Date(), rejectedReason: why },
  });
  if (moved.count !== 1) throw new OpsError(409, "The claim changed concurrently — reload");
  await audit(tx, actor, id, "reject", `rejected ${c.number ?? id}: ${why}`);
  return { status: "rejected" as const };
}

/** Reimburse an approved claim — gated OPS_EXPENSE_REIMBURSE (propose without approvalId). */
export async function reimburseExpenseClaim(tx: Tx, actor: OpsActor, id: string, approvalId: string | null | undefined, port: OpsGatePort = phase14GatePort) {
  const c = await loadClaim(tx, actor.workspaceId, id);
  if (c.status !== "approved") throw new OpsError(422, `Only an approved claim can be reimbursed (it is ${c.status})`);
  if (!approvalId) {
    const approval = await requestOpsApproval(port, {
      workspaceId: actor.workspaceId,
      slug: "OPS_EXPENSE_REIMBURSE",
      entity: "expense-claims",
      entityId: id,
      mutation: reimburseBinding(id, c.totalCents),
      actor: actor.userId,
      summary: `Reimburse ${fmtMoney(c.totalCents)} for expense claim ${c.number ?? id} "${c.title}"`,
    });
    await audit(tx, actor, id, "gate_proposed", `reimbursement proposed (approval ${approval.id})`);
    return { outcome: "approval_required" as const, approval };
  }
  await verifyAndConsumeOpsApproval(port, tx, {
    workspaceId: actor.workspaceId,
    slug: "OPS_EXPENSE_REIMBURSE",
    entity: "expense-claims",
    entityId: id,
    mutation: reimburseBinding(id, c.totalCents),
    approvalId,
    actor: actor.userId,
  });
  const moved = await tx.opsExpenseClaim.updateMany({ where: { id, workspaceId: actor.workspaceId, status: "approved" }, data: { status: "reimbursed", reimbursedAt: new Date() } });
  if (moved.count !== 1) throw new OpsError(409, "The claim changed concurrently — reload");
  const posted = await postExpenseReimbursed(tx, actor, { id, number: c.number, totalCents: c.totalCents });
  await audit(tx, actor, id, "gate_executed", `reimbursed ${c.number ?? id} (approval ${approvalId}); posted ${posted?.entry.id ?? "nothing"}`);
  return { outcome: "done" as const, status: "reimbursed" as const, entryId: posted?.entry.id ?? null };
}

export async function getExpenseClaim(tx: Tx, workspaceId: string, id: string) {
  return loadClaim(tx, workspaceId, id);
}
