// ShapesOS — Phase 12 (people): payroll on real Postgres, as the
// least-privilege app role, through the REAL Phase 14 gate:
//   - structure / assignment rules: pay-type fields, components, no
//     overlapping assignments for one person
//   - compute: one payslip per assigned member, salary + APPROVED hourly time
//     (pending time ignored) with overtime; totals = Σ payslips; numbered
//   - a pay run CANNOT be posted without approval: in code (409 / gate) and
//     in the database (CHECKs + lifecycle trigger refuse raw UPDATEs)
//   - approval binds the computed numbers (a recompute that changes them
//     invalidates it); approved runs and their payslips are frozen
//   - posting writes ONE balanced journal entry; re-posting is a no-op
//   - YTD wage bases come from approved/posted runs; the same person can't be
//     paid twice for overlapping days; cancelling frees the period
//   - FORCE RLS on all four payroll tables
// Run (DB suite): DATABASE_URL=<app role url> MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/ops/__tests__/p12-payroll-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { decideApproval } from "@/lib/integrations/actions/gate";
import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsCreate, opsList, opsPatch, type OpsActor } from "../doctype";
import { OpsGateError } from "../gate";
import { findEntryBySource } from "../accounting";
import { postPayRunEntry } from "../finance/posting";
import { approvePayRun, cancelPayRun, computePayRun, postPayRun, ytdWagesFor } from "../payroll/runs";
import { payrollDraftRunCore, payrollRequestCore } from "@/lib/chat/ops-people-tools";

const WS = "p12pay-ws-a";
const WS_B = "p12pay-ws-b";
const OWNER = "user_p12pay_owner";
const ADMIN: OpsActor = { workspaceId: WS, userId: "user_p12pay_admin" };
const OWNER_ACTOR: OpsActor = { workspaceId: WS, userId: OWNER };
const B: OpsActor = { workspaceId: WS_B, userId: "user_p12pay_b" };
const BOB_USER = "user_p12pay_bob";
const def = (slug: string) => OPS_ENTITY_MAP[slug]!;
const rowOf = (r: unknown) => (r as { row: Record<string, unknown> }).row;
const ids = { ada: "", bob: "", salaried: "", hourly: "", project: "", adaAssign: "" };

async function ws(id: string, owner: string) {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${owner}, now())`;
}

const create = async (actor: OpsActor, slug: string, body: Record<string, unknown>) => rowOf(await withWorkspaceScope(actor.workspaceId, (tx) => opsCreate(tx, def(slug), actor, body)));
const run = (id: string) => withWorkspaceScope(WS, (tx) => tx.opsPayRun.findFirstOrThrow({ where: { id, workspaceId: WS } }));
const slips = (runId: string) => withWorkspaceScope(WS, (tx) => tx.opsPayslip.findMany({ where: { workspaceId: WS, payRunId: runId }, orderBy: { memberName: "asc" } }));

before(async () => {
  await ws(WS, OWNER);
  await ws(WS_B, "user_p12pay_b");
  await withWorkspaceScope(WS, async (tx) => {
    ids.ada = (await tx.opsTeamMember.create({ data: { workspaceId: WS, name: "Ada Salaried" } })).id;
    ids.bob = (await tx.opsTeamMember.create({ data: { workspaceId: WS, name: "Bob Hourly", userId: BOB_USER } })).id;
  });
  ids.project = String((await create(ADMIN, "projects", { name: "Client work" })).id);
  // Bob's time in the period 2026-03-02 .. 2026-03-15 (two workweeks):
  // week 1: 45 h approved; week 2: 30 h approved + 10 h still pending.
  await withWorkspaceScope(WS, async (tx) => {
    const t = (day: string, minutes: number, approvalStatus: "approved" | "pending") =>
      tx.opsTimeEntry.create({ data: { workspaceId: WS, projectId: ids.project, userId: BOB_USER, minutes, occurredAt: new Date(`${day}T15:00:00Z`), approvalStatus } });
    for (const d of ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"]) await t(d, 540, "approved");
    await t("2026-03-09", 900, "approved");
    await t("2026-03-10", 900, "approved");
    await t("2026-03-11", 600, "pending");
    // Outside the period: never paid in this run.
    await t("2026-03-20", 600, "approved");
  });
});

after(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS_B}`;
  await prisma.$disconnect();
});

describe("salary structures and assignments", () => {
  it("validates pay fields and components", async () => {
    await assert.rejects(create(ADMIN, "salary-structures", { name: "Bad", payType: "salary", hourlyRateCents: 2000 }), (e: unknown) => e instanceof OpsError && e.status === 400);
    await assert.rejects(create(ADMIN, "salary-structures", { name: "Bad2", payType: "salary", annualSalaryCents: 1, components: [{ code: "x", kind: "bonus", amountCents: 1 }] }), /kind must be/);
    await assert.rejects(create(ADMIN, "salary-structures", { name: "Bad3", payType: "salary", annualSalaryCents: 1, country: "GB" }), (e: unknown) => e instanceof OpsError && e.status === 422);
    ids.salaried = String(
      (
        await create(ADMIN, "salary-structures", {
          name: "Salaried",
          payType: "salary",
          payFrequency: "biweekly",
          annualSalaryCents: 5_200_000,
          components: [
            { code: "401k", label: "401(k)", kind: "pre_tax_deduction", calc: "percent", rateBps: 500 },
            { code: "match", label: "401(k) match", kind: "employer_contribution", calc: "percent", rateBps: 300 },
          ],
        })
      ).id,
    );
    ids.hourly = String((await create(ADMIN, "salary-structures", { name: "Hourly", payType: "hourly", payFrequency: "biweekly", hourlyRateCents: 2_000 })).id);
    await assert.rejects(create(ADMIN, "salary-structures", { name: "Hourly", payType: "hourly", hourlyRateCents: 1 }), (e: unknown) => e instanceof OpsError && e.status === 409);
  });

  it("assignments never overlap for one person", async () => {
    ids.adaAssign = String((await create(ADMIN, "salary-assignments", { memberId: ids.ada, structureId: ids.salaried, effectiveFrom: "2026-01-01", stateCode: "IL" })).id);
    await assert.rejects(
      create(ADMIN, "salary-assignments", { memberId: ids.ada, structureId: ids.hourly, effectiveFrom: "2026-06-01" }),
      (e: unknown) => e instanceof OpsError && e.status === 409,
    );
    await assert.rejects(create(ADMIN, "salary-assignments", { memberId: ids.bob, structureId: ids.hourly, effectiveFrom: "2026-01-01", annualSalaryCents: 1 }), /hourly rate/);
    await create(ADMIN, "salary-assignments", { memberId: ids.bob, structureId: ids.hourly, effectiveFrom: "2026-01-01" });
    await assert.rejects(
      withWorkspaceScope(WS, (tx) => opsPatch(tx, def("salary-assignments"), ADMIN, { id: ids.adaAssign, effectiveTo: "2025-12-01" })),
      /on or after/,
    );
  });
});

describe("pay runs", () => {
  let runId = "";

  it("computes one payslip per member from salary and APPROVED time", async () => {
    const draft = await create(ADMIN, "pay-runs", { periodStart: "2026-03-02", periodEnd: "2026-03-15", payDate: "2026-03-20" });
    runId = String(draft.id);
    assert.equal(draft.status, "draft");
    const r = await withWorkspaceScope(WS, (tx) => computePayRun(tx, ADMIN, runId));
    assert.equal(r.payslipCount, 2);
    assert.match(r.run.number!, /^PAY-\d{4}$/);
    assert.equal(r.run.status, "computed");
    const [ada, bob] = await slips(runId);
    assert.equal(ada!.memberName, "Ada Salaried");
    assert.equal(ada!.grossCents, 200_000);
    assert.equal(ada!.preTaxDeductionCents, 10_000);
    assert.equal(ada!.employerContribCents, 6_000);
    assert.ok((ada!.lines as Array<{ code: string }>).some((l) => l.code === "us_state_il"));
    // Bob: 45 h week 1 (40 + 5 OT) + 30 h week 2; the pending 10 h and the
    // entry after the period are not paid.
    assert.equal(bob!.regularMinutes, 4200);
    assert.equal(bob!.overtimeMinutes, 300);
    assert.equal(bob!.grossCents, 155_000);
    const all = await slips(runId);
    const row = await run(runId);
    assert.equal(row.grossCents, all.reduce((s, p) => s + p.grossCents, 0));
    assert.equal(row.netCents, all.reduce((s, p) => s + p.netCents, 0));
    assert.equal(row.employerTaxCents, all.reduce((s, p) => s + p.employerTaxCents, 0));
    assert.ok(row.computeDigest && row.computeDigest.length === 64);
  });

  it("can't be approved or posted without an approval — in code", async () => {
    await assert.rejects(withWorkspaceScope(WS, (tx) => postPayRun(tx, ADMIN, runId, undefined)), (e: unknown) => e instanceof OpsError && e.status === 409);
    await assert.rejects(withWorkspaceScope(WS, (tx) => approvePayRun(tx, ADMIN, runId, "not-an-approval")), (e: unknown) => e instanceof OpsGateError);
    assert.equal((await run(runId)).status, "computed");
  });

  it("can't be approved or posted without an approval — in the database", async () => {
    const raw = (sql: string) => withWorkspaceScope(WS, (tx) => tx.$executeRawUnsafe(sql, runId));
    await assert.rejects(raw(`UPDATE ops_pay_runs SET status = 'posted', journal_entry_id = 'je_fake', posted_at = now() WHERE id = $1`), /check|violat|approved/i);
    await assert.rejects(raw(`UPDATE ops_pay_runs SET status = 'approved' WHERE id = $1`), /ops_pay_runs_approval_chk|check/i);
    await assert.rejects(raw(`UPDATE ops_pay_runs SET net_cents = net_cents + 1 WHERE id = $1`), /ops_pay_runs_totals_chk|check/i);
    assert.equal((await run(runId)).status, "computed");
  });

  it("the agent can only PROPOSE approval (Tier 3), and a recompute with new numbers invalidates it", async () => {
    const proposed = await withWorkspaceScope(WS, (tx) => payrollRequestCore(tx, ADMIN, { payRunId: runId }, "approve"));
    const staleApproval = String((proposed.details as { approvalId: string }).approvalId);
    assert.equal((await run(runId)).approvalId, staleApproval);
    await decideApproval({ workspaceId: WS, approvalId: staleApproval, decision: "approved", decidedBy: OWNER });
    // Ada gets a raise before anyone executes the approval → new numbers.
    await withWorkspaceScope(WS, (tx) => opsPatch(tx, def("salary-assignments"), ADMIN, { id: ids.adaAssign, annualSalaryCents: 5_460_000 }));
    await withWorkspaceScope(WS, (tx) => computePayRun(tx, ADMIN, runId));
    assert.equal((await run(runId)).approvalId, null, "recompute clears the pending request");
    await assert.rejects(
      withWorkspaceScope(WS, (tx) => approvePayRun(tx, ADMIN, runId, staleApproval)),
      (e: unknown) => e instanceof OpsGateError && e.code === "binding_mismatch",
    );
    assert.equal((await run(runId)).status, "computed");
  });

  it("approve (person) → frozen → post (person) writes ONE balanced entry; re-post is a no-op", async () => {
    const p1 = await withWorkspaceScope(WS, (tx) => approvePayRun(tx, ADMIN, runId, undefined));
    assert.equal(p1.outcome, "approval_required");
    const approvalId = (p1 as { approval: { id: string } }).approval.id;
    await decideApproval({ workspaceId: WS, approvalId, decision: "approved", decidedBy: OWNER });
    const done = await withWorkspaceScope(WS, (tx) => approvePayRun(tx, ADMIN, runId, approvalId));
    assert.equal(done.outcome, "done");
    const approved = await run(runId);
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvalId, approvalId);
    // Replay of the same approval is refused.
    await assert.rejects(withWorkspaceScope(WS, (tx) => approvePayRun(tx, ADMIN, runId, approvalId)), /Only a computed/);
    // Frozen: no recompute, no payslip writes, no total edits.
    await assert.rejects(withWorkspaceScope(WS, (tx) => computePayRun(tx, ADMIN, runId)), /Only a draft or computed/);
    await assert.rejects(
      withWorkspaceScope(WS, (tx) => tx.$executeRawUnsafe(`UPDATE ops_payslips SET member_name = 'X' WHERE pay_run_id = $1`, runId)),
      /frozen/,
    );
    await assert.rejects(withWorkspaceScope(WS, (tx) => tx.$executeRawUnsafe(`UPDATE ops_pay_runs SET status = 'computed' WHERE id = $1`, runId)), /frozen/);

    const p2 = await withWorkspaceScope(WS, (tx) => postPayRun(tx, ADMIN, runId, undefined));
    assert.equal(p2.outcome, "approval_required");
    const postApproval = (p2 as { approval: { id: string } }).approval.id;
    await assert.rejects(withWorkspaceScope(WS, (tx) => postPayRun(tx, ADMIN, runId, postApproval)), (e: unknown) => e instanceof OpsGateError, "not decided yet");
    await decideApproval({ workspaceId: WS, approvalId: postApproval, decision: "approved", decidedBy: OWNER });
    const posted = await withWorkspaceScope(WS, (tx) => postPayRun(tx, ADMIN, runId, postApproval));
    assert.equal(posted.outcome, "done");
    const r = await run(runId);
    assert.equal(r.status, "posted");

    const entry = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `pay_run:${runId}:post`));
    assert.ok(entry);
    assert.equal(entry!.id, r.journalEntryId);
    const debit = entry!.lines.reduce((s, l) => s + l.debitCents, 0);
    const credit = entry!.lines.reduce((s, l) => s + l.creditCents, 0);
    assert.equal(debit, credit, "balanced");
    const all = await slips(runId);
    const by = Object.fromEntries(entry!.lines.map((l) => [l.accountCode, l.debitCents || -l.creditCents]));
    assert.equal(by["6700"], r.grossCents);
    assert.equal(by["6710"], r.employerTaxCents);
    assert.equal(by["6720"], all.reduce((s, p) => s + p.employerContribCents, 0));
    assert.equal(by["2310"], -r.netCents);
    assert.equal(by["2300"], -(r.employeeTaxCents + r.employerTaxCents));

    // Idempotent: the action and the posting function both return the one entry.
    const again = await withWorkspaceScope(WS, (tx) => postPayRun(tx, ADMIN, runId, undefined));
    assert.equal(again.outcome, "done");
    const direct = await withWorkspaceScope(WS, async (tx) => postPayRunEntry(tx, ADMIN, { ...(await tx.opsPayRun.findFirstOrThrow({ where: { id: runId, workspaceId: WS } })), preTaxDeductionCents: all.reduce((s, p) => s + p.preTaxDeductionCents, 0), postTaxDeductionCents: 0 }));
    assert.equal(direct.created, false);
    const n = await withWorkspaceScope(WS, (tx) => tx.opsJournalEntry.count({ where: { workspaceId: WS, sourceKey: `pay_run:${runId}:post` } }));
    assert.equal(n, 1);
    // Posted is final.
    await assert.rejects(withWorkspaceScope(WS, (tx) => cancelPayRun(tx, ADMIN, runId)), /can't be cancelled/);
    await assert.rejects(withWorkspaceScope(WS, (tx) => tx.$executeRawUnsafe(`UPDATE ops_pay_runs SET notes = 'x' WHERE id = $1`, runId)), /final/);
  });

  it("YTD wage bases come from approved/posted runs; nobody is paid twice for the same days", async () => {
    const all = await slips(runId);
    const ytd = await withWorkspaceScope(WS, (tx) => ytdWagesFor(tx, WS, ids.ada, new Date("2026-04-03T00:00:00Z"), "other"));
    assert.equal(ytd.ssWagesCents, all.find((s) => s.memberId === ids.ada)!.ssWagesCents);
    const overlap = await create(ADMIN, "pay-runs", { periodStart: "2026-03-09", periodEnd: "2026-03-22", payDate: "2026-03-27" });
    await assert.rejects(withWorkspaceScope(WS, (tx) => computePayRun(tx, ADMIN, String(overlap.id))), /Already in another pay run/);
    await withWorkspaceScope(WS, (tx) => cancelPayRun(tx, ADMIN, String(overlap.id)));
    // Through the agent tool: drafts + computes the next period, never approves.
    const tool = await withWorkspaceScope(WS, (tx) => payrollDraftRunCore(tx, ADMIN, { periodStart: "2026-03-16", periodEnd: "2026-03-29", payDate: "2026-04-03" }));
    const next = String((tool.details as { payRunId: string }).payRunId);
    assert.equal((await run(next)).status, "computed");
    // A cancelled computed run frees its period.
    await withWorkspaceScope(WS, (tx) => cancelPayRun(tx, ADMIN, next));
    const redo = await create(ADMIN, "pay-runs", { periodStart: "2026-03-16", periodEnd: "2026-03-29", payDate: "2026-04-03" });
    assert.equal((await withWorkspaceScope(WS, (tx) => computePayRun(tx, ADMIN, String(redo.id)))).payslipCount, 2);
  });
});

describe("payroll RLS", () => {
  it("another workspace sees none of it; no GUC sees nothing", async () => {
    for (const slug of ["salary-structures", "salary-assignments", "pay-runs", "payslips"]) {
      const mine = await withWorkspaceScope(WS, (tx) => opsList(tx, def(slug), ADMIN, { limit: 200 }));
      assert.ok(mine.rows.length > 0, `${slug} has rows`);
      const theirs = await withWorkspaceScope(WS_B, (tx) => opsList(tx, def(slug), B, { limit: 200 }));
      assert.equal(theirs.rows.length, 0, `${slug} hidden from B`);
    }
    assert.equal(await prisma.opsPayRun.count(), 0);
    assert.equal(await prisma.opsPayslip.count(), 0);
    assert.equal(await prisma.opsSalaryStructure.count(), 0);
    assert.equal(await prisma.opsSalaryAssignment.count(), 0);
    // A cross-workspace write is refused by WITH CHECK.
    await assert.rejects(withWorkspaceScope(WS_B, (tx) => tx.opsSalaryStructure.create({ data: { workspaceId: WS, name: "sneaky" } })));
  });

  it("payslips can't be created through the generic API", async () => {
    await assert.rejects(create(ADMIN, "payslips", { payRunId: "x" }), (e: unknown) => e instanceof OpsError && e.status === 405);
  });

  it("a person (the owner) decided every executed payroll approval", async () => {
    const decided = await withWorkspaceScope(WS, (tx) => tx.composioActionApproval.findMany({ where: { workspaceId: WS, toolName: { in: ["OPS_PAYROLL_APPROVE", "OPS_PAYROLL_POST"] }, status: "executed" } }));
    assert.ok(decided.length >= 2);
    assert.ok(decided.every((a) => a.decidedBy === OWNER), "decided by a person (the owner), never the requesting admin or an agent");
  });
});

void OWNER_ACTOR;
