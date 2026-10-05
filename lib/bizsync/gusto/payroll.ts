// ShapesOS — Phase 14 (connectors): the Gusto payroll engine (DB + the Gusto
// API in lib/bizsync/gusto/api.ts; pure mapping in ./map.ts).
//
// EMPLOYEES  OpsTeamMember ↔ Gusto employee through biz_sync_links
//            (provider "gusto", objectType "employee"). Matches are suggested
//            by email (agent tool gusto.sync_employees, Tier 2, asks) and
//            CONFIRMED only by a person (Settings → Connectors → Business
//            sync); only confirmed links are ever used to pay anyone.
// PAY RUN    (lib/ops/payroll/runs.ts keeps the lifecycle; provider.ts the guards)
//   1. compute in ShapesOS as before (salaries + approved timesheets);
//   2. SEND (Tier 3 — never automated, always asks: the OPS_PAYROLL_SEND_PROVIDER
//      ops approval from the pay run page, or a confirmed
//      connector.gusto.send_payroll call whose action kind
//      send_payroll_to_provider is in TIER3_EXACT_KINDS): find the
//      UNPROCESSED regular Gusto payroll for exactly the run's period,
//      prepare it, write each matched hourly person's Regular/Overtime hours.
//      Idempotent per run + compute digest (a repeated send is a no-op; the
//      hours are absolute values, so even a retried request can't add pay);
//   3. the person reviews and SUBMITS in Gusto (ShapesOS never submits — Gusto
//      calculates taxes; the API doesn't process payroll);
//   4. SYNC RESULTS: the processed payroll's per-employee taxes, deductions
//      and net pay replace the payslip figures (computed run only — after
//      approval nothing on the run changes; differences are recorded);
//   5. approve + post with the existing gates (Tier 3) — Gusto's figures;
//   6. when Gusto has paid (processed, check date reached), Net pay payable
//      is cleared with ONE balanced payment entry (idempotent).
// Without Gusto none of this runs: the built-in tax tables remain, with the
// accountant banner. Every network call is UNVERIFIED-LIVE until demo keys.

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { requireEntitlementTx } from "@/lib/billing/entitlements-server";
import { ConnectorApiError, type LiveDeps } from "@/lib/connectors/m21/live/http";
import { OpsError, type OpsActor } from "@/lib/ops/doctype";
import { phase14GatePort, requestOpsApproval, verifyAndConsumeOpsApproval, type OpsGatePort, type OpsGateProposal } from "@/lib/ops/gate";
import { payRunDigest, loadPayRun, payRunLabel } from "@/lib/ops/payroll/runs";
import { runTotals, type PayslipLine } from "@/lib/ops/payroll/rules";
import { clearNetPayIfPaid, providerSyncFor } from "@/lib/ops/payroll/provider";
import { fmtMoney } from "@/lib/ops/finance/money";
import { findLink, recordRun } from "../links";
import { gustoEmployees, gustoPayroll, gustoPayrolls, gustoPreparePayroll, gustoUpdatePayroll, type GustoAuth, type GustoEmployee, type GustoEmployeeCompensation } from "./api";
import { chunkUpdate, employeeName, gustoPayrollPaid, matchEmployeesByEmail, payslipFromGusto, pickPayrollForPeriod, planPayrollUpdate, sendKey, type GustoSlipFigures, GustoMappingError } from "./map";

type Tx = Prisma.TransactionClient;
const P = "gusto" as const;
const OBJ = "employee";
// Network calls happen inside the run's transaction (the approval is only
// consumed when the send succeeded), so allow more than Prisma's 5 s.
const TX_TIMEOUT_MS = 120_000;

const day = (d: Date) => d.toISOString().slice(0, 10);

async function audit(tx: Tx, actor: OpsActor, entity: string, id: string | null, action: string, summary: string) {
  await tx.opsAuditEvent.create({ data: { workspaceId: actor.workspaceId, entity, entityId: id, action, actor: actor.userId, summary: summary.slice(0, 2000) } });
}

// ---------------------------------------------------------------------------
// Employee links
// ---------------------------------------------------------------------------

interface LinkMeta {
  confirmed?: boolean;
  email?: string;
  name?: string;
  matchedBy?: string;
  confirmedBy?: string;
  confirmedAt?: string;
}

const metaOf = (m: unknown): LinkMeta => (m && typeof m === "object" ? (m as LinkMeta) : {});

/** memberId → Gusto employee uuid, CONFIRMED links only. */
export async function confirmedGustoLinks(tx: Tx, workspaceId: string): Promise<Map<string, string>> {
  const rows = await tx.bizSyncLink.findMany({ where: { workspaceId, provider: P, objectType: OBJ }, select: { remoteId: true, localId: true, meta: true } });
  return new Map(rows.filter((r) => metaOf(r.meta).confirmed === true).map((r) => [r.localId, r.remoteId]));
}

export interface EmployeeView {
  remote: Array<{ id: string; name: string; email: string | null; terminated: boolean }>;
  local: Array<{ id: string; name: string; email: string | null; status: string }>;
  links: Array<{ remoteId: string; localId: string; confirmed: boolean; matchedBy: string | null }>;
  suggestions: Array<{ remoteId: string; localId: string; email: string }>;
  truncated: boolean;
}

/** What the Business sync page shows: Gusto employees, team members, links and fresh email suggestions. */
export async function gustoEmployeeView(workspaceId: string, auth: GustoAuth, deps: LiveDeps = {}): Promise<EmployeeView> {
  const emps = await gustoEmployees(auth, deps);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const members = await tx.opsTeamMember.findMany({ where: { workspaceId }, select: { id: true, name: true, email: true, status: true }, orderBy: { name: "asc" }, take: 1000 });
    const links = await tx.bizSyncLink.findMany({ where: { workspaceId, provider: P, objectType: OBJ }, select: { remoteId: true, localId: true, meta: true } });
    const linkedRemote = new Set(links.map((l) => l.remoteId));
    const linkedLocal = new Set(links.map((l) => l.localId));
    const { matches } = matchEmployeesByEmail(members, emps.items);
    return {
      remote: emps.items.map((e) => ({ id: e.uuid, name: employeeName(e), email: e.email ?? e.work_email ?? null, terminated: e.terminated === true })),
      local: members.map((m) => ({ id: m.id, name: m.name, email: m.email, status: m.status })),
      links: links.map((l) => ({ remoteId: l.remoteId, localId: l.localId, confirmed: metaOf(l.meta).confirmed === true, matchedBy: metaOf(l.meta).matchedBy ?? null })),
      suggestions: matches.filter((m) => !linkedRemote.has(m.employeeUuid) && !linkedLocal.has(m.memberId)).map((m) => ({ remoteId: m.employeeUuid, localId: m.memberId, email: m.email })),
      truncated: emps.truncated,
    };
  });
}

/**
 * Agent tool gusto.sync_employees: save email matches as SUGGESTED links
 * (meta.confirmed false). Never confirms, never touches a confirmed link.
 */
export async function suggestGustoLinks(workspaceId: string, auth: GustoAuth, userId: string, deps: LiveDeps = {}) {
  const emps = await gustoEmployees(auth, deps);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const members = await tx.opsTeamMember.findMany({ where: { workspaceId }, select: { id: true, name: true, email: true, status: true }, take: 1000 });
    const { matches, ambiguous } = matchEmployeesByEmail(members, emps.items);
    let suggested = 0;
    let alreadyLinked = 0;
    for (const m of matches) {
      const byRemote = await findLink(tx, workspaceId, P, OBJ, { remoteId: m.employeeUuid });
      const byLocal = await findLink(tx, workspaceId, P, OBJ, { localId: m.memberId });
      if (byRemote || byLocal) {
        alreadyLinked += 1;
        continue;
      }
      const emp = emps.items.find((e) => e.uuid === m.employeeUuid)!;
      await tx.bizSyncLink.create({ data: { workspaceId, provider: P, objectType: OBJ, remoteId: m.employeeUuid, localId: m.memberId, meta: { confirmed: false, email: m.email, name: employeeName(emp), matchedBy: "email" } } });
      suggested += 1;
    }
    const matchedMembers = new Set(matches.map((m) => m.memberId));
    const matchedEmployees = new Set(matches.map((m) => m.employeeUuid));
    if (suggested > 0) await audit(tx, { workspaceId, userId }, "team-members", null, "gusto_suggest", `${suggested} Gusto employee match(es) suggested by email — a person confirms them on Business sync`);
    return {
      suggested,
      alreadyLinked,
      ambiguous: ambiguous.length,
      unmatchedMembers: members.filter((m) => !matchedMembers.has(m.id)).length,
      unmatchedEmployees: emps.items.filter((e) => !matchedEmployees.has(e.uuid)).length,
      truncated: emps.truncated,
      info: suggested ? "Suggested matches are not used for pay until a person confirms them (Settings → Connectors → Business sync → Gusto)." : undefined,
    };
  });
}

export class GustoLinkError extends Error {}

/**
 * A PERSON confirms (memberId) or clears (null) the link for one Gusto
 * employee. `employees` is the live Gusto list the route just fetched — a
 * link to an employee Gusto doesn't have is refused.
 */
export async function setGustoEmployeeLink(workspaceId: string, remoteEmployeeId: string, memberId: string | null, userId: string, employees: GustoEmployee[]): Promise<{ ok: true }> {
  const emp = employees.find((e) => e.uuid === remoteEmployeeId);
  if (!emp) throw new GustoLinkError("That Gusto employee isn't in the connected company");
  return withWorkspaceScope(workspaceId, async (tx) => {
    const actor = { workspaceId, userId };
    const existing = await findLink(tx, workspaceId, P, OBJ, { remoteId: remoteEmployeeId });
    if (memberId === null) {
      if (existing) {
        await tx.bizSyncLink.deleteMany({ where: { id: existing.id, workspaceId } });
        await audit(tx, actor, "team-members", existing.localId, "gusto_unlink", `Unlinked Gusto employee ${employeeName(emp)}`);
      }
      return { ok: true as const };
    }
    const member = await tx.opsTeamMember.findFirst({ where: { id: memberId, workspaceId }, select: { id: true, name: true } });
    if (!member) throw new GustoLinkError("Team member not found");
    const other = await findLink(tx, workspaceId, P, OBJ, { localId: memberId });
    if (other && other.remoteId !== remoteEmployeeId) throw new GustoLinkError(`${member.name} is already linked to another Gusto employee — unlink that one first`);
    const meta = { ...metaOf(existing?.meta), confirmed: true, name: employeeName(emp), email: emp.email ?? emp.work_email ?? undefined, confirmedBy: userId, confirmedAt: new Date().toISOString(), matchedBy: existing && existing.localId === memberId ? metaOf(existing.meta).matchedBy ?? "person" : "person" };
    await tx.bizSyncLink.upsert({
      where: { workspaceId_provider_objectType_remoteId: { workspaceId, provider: P, objectType: OBJ, remoteId: remoteEmployeeId } },
      create: { workspaceId, provider: P, objectType: OBJ, remoteId: remoteEmployeeId, localId: memberId, meta, lastDirection: "pull" },
      update: { localId: memberId, meta },
    });
    await audit(tx, actor, "team-members", memberId, "gusto_link", `${member.name} confirmed as Gusto employee ${employeeName(emp)}`);
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Send a pay run (Tier 3)
// ---------------------------------------------------------------------------

/**
 * How this send was authorized — there is no third way:
 *   ops_approval         the pay run page: OPS_PAYROLL_SEND_PROVIDER, proposed
 *                        on the first call, verified + consumed (bound to the
 *                        run's digest) on the second;
 *   confirmed_tool_call  connector.gusto.send_payroll AFTER the person
 *                        confirmed it in chat (lib/chat/connector-tools.ts:
 *                        its action send_payroll_to_provider is Tier 3, so no
 *                        automation rule can skip that confirmation).
 */
export type GustoSendAuthorization = { kind: "ops_approval"; approvalId: string | null | undefined; port?: OpsGatePort } | { kind: "confirmed_tool_call" };

export type GustoSendResult =
  | { outcome: "approval_required"; approval: OpsGateProposal }
  | { outcome: "done"; alreadySent: boolean; payrollId: string; checkDate: string | null; sent: number; salaried: number; skipped: Array<{ memberName: string; reason: string }>; warnings: string[] };

export const sendBinding = (r: { id: string; computeDigest: string | null; grossCents: number; netCents: number; payslipCount: number }) => ({ id: r.id, send: P, digest: r.computeDigest, grossCents: r.grossCents, netCents: r.netCents, payslips: r.payslipCount });

function gustoError(err: unknown): never {
  if (err instanceof ConnectorApiError && err.status === 409) {
    throw new OpsError(409, "Gusto's payroll changed while ShapesOS was writing to it (version conflict). Nothing was overwritten — send again: ShapesOS prepares the payroll fresh first.");
  }
  if (err instanceof ConnectorApiError && err.status === 422) {
    throw new OpsError(422, `Gusto refused the payroll update: ${err.message}`);
  }
  throw err;
}

export async function sendPayRunToGusto(workspaceId: string, runId: string, auth: GustoAuth, actor: OpsActor, authz: GustoSendAuthorization, deps: LiveDeps = {}): Promise<GustoSendResult> {
  return withWorkspaceScope(
    workspaceId,
    async (tx) => {
      // Phase 15.3 (pricing): pushing a run to Gusto is producing payroll —
      // the payroll feature is needed (Pro and up; trial/self-hosted keep it).
      await requireEntitlementTx(tx, workspaceId, "payroll");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll-run:${workspaceId}`}))`;
      const run = await loadPayRun(tx, workspaceId, runId);
      if (run.status !== "computed") throw new OpsError(409, `Send to Gusto works on a computed pay run (before approval) — this one is ${run.status}`);
      if (run.payslipCount === 0 || !run.computeDigest) throw new OpsError(422, "Compute the pay run first");
      const sync = await providerSyncFor(tx, workspaceId, runId);
      if (sync && sync.provider !== P) throw new OpsError(409, `This run is handled by ${sync.provider}`);
      if (sync && (sync.status === "synced" || sync.status === "paid")) throw new OpsError(409, "Gusto already processed this payroll — its results are on the payslips");
      const summary = (sync?.summary ?? {}) as Record<string, unknown>;
      // IDEMPOTENT: the same run with the same figures was already sent.
      if (sync && sync.status === "sent" && sync.sentDigest === run.computeDigest && sync.remotePayrollId) {
        return {
          outcome: "done",
          alreadySent: true,
          payrollId: sync.remotePayrollId,
          checkDate: typeof summary.checkDate === "string" ? summary.checkDate : null,
          sent: Array.isArray(summary.sent) ? summary.sent.length : 0,
          salaried: Array.isArray(summary.salaried) ? summary.salaried.length : 0,
          skipped: Array.isArray(summary.skipped) ? (summary.skipped as Array<{ memberName: string; reason: string }>) : [],
          warnings: Array.isArray(summary.warnings) ? (summary.warnings as string[]) : [],
        };
      }
      if (authz.kind === "ops_approval") {
        const port = authz.port ?? phase14GatePort;
        if (!authz.approvalId) {
          const approval = await requestOpsApproval(port, {
            workspaceId,
            slug: "OPS_PAYROLL_SEND_PROVIDER",
            entity: "pay-runs",
            entityId: runId,
            mutation: sendBinding(run),
            actor: actor.userId,
            summary: `Send pay run ${payRunLabel(run)} (${day(run.periodStart)} to ${day(run.periodEnd)}) to Gusto: hours for ${run.payslipCount} payslip(s), gross ${fmtMoney(run.grossCents)} as computed here — Gusto computes the taxes; you submit it in Gusto.`,
          });
          await audit(tx, actor, "pay-runs", runId, "gate_proposed", `Gusto send approval ${approval.id} requested for ${payRunLabel(run)}`);
          return { outcome: "approval_required", approval };
        }
        await verifyAndConsumeOpsApproval(port, tx, { workspaceId, slug: "OPS_PAYROLL_SEND_PROVIDER", entity: "pay-runs", entityId: runId, mutation: sendBinding(run), approvalId: authz.approvalId, actor: actor.userId });
      }

      // The matching UNPROCESSED regular payroll for exactly this period.
      const start = day(run.periodStart);
      const end = day(run.periodEnd);
      const open = await gustoPayrolls(auth, { processingStatuses: "unprocessed", startDate: start, endDate: end }, deps);
      const { payroll, ambiguous } = pickPayrollForPeriod(open, start, end);
      if (ambiguous) throw new OpsError(409, `Gusto has more than one open regular payroll for ${start} to ${end} — resolve it in Gusto first`);
      if (!payroll) throw new OpsError(422, `Gusto has no open (unprocessed) regular payroll for ${start} to ${end}. Make the run's period match a Gusto pay period.`);

      const links = await confirmedGustoLinks(tx, workspaceId);
      const slips = await tx.opsPayslip.findMany({ where: { workspaceId, payRunId: runId }, orderBy: { memberName: "asc" } });
      const forSend = slips.map((s) => ({ memberId: s.memberId, memberName: s.memberName, payType: s.payType, regularMinutes: s.regularMinutes, overtimeMinutes: s.overtimeMinutes, lines: (s.lines as unknown as PayslipLine[]) ?? [] }));
      const linkedUuids = [...new Set(forSend.filter((s) => links.has(s.memberId)).map((s) => links.get(s.memberId)!))];
      // Prepare (≤ 100 employees per call) → per-employee versions.
      const comps: GustoEmployeeCompensation[] = [];
      for (let i = 0; i < linkedUuids.length; i += 100) {
        const prepared = await gustoPreparePayroll(auth, payroll.payroll_uuid, linkedUuids.slice(i, i + 100), deps).catch(gustoError);
        comps.push(...(prepared.employee_compensations ?? []));
      }
      const plan = planPayrollUpdate({ ...payroll, employee_compensations: comps }, forSend, links);
      if (plan.sent.length === 0 && plan.salaried.length === 0) {
        throw new OpsError(422, `Nothing to send: ${plan.skipped.map((s) => `${s.memberName} — ${s.reason}`).join("; ") || "no payslips are matched to Gusto employees"}`);
      }
      for (const batch of chunkUpdate(plan.body)) {
        await gustoUpdatePayroll(auth, payroll.payroll_uuid, batch, deps).catch(gustoError);
      }
      const key = sendKey(runId, run.computeDigest, payroll.payroll_uuid);
      const now = new Date();
      const newSummary = {
        sendKey: key,
        checkDate: payroll.check_date ?? null,
        payrollDeadline: payroll.payroll_deadline ?? null,
        payPeriod: { start, end },
        sent: plan.sent,
        salaried: plan.salaried,
        skipped: plan.skipped,
        warnings: plan.warnings,
      };
      await tx.opsPayRunProviderSync.upsert({
        where: { payRunId_provider: { payRunId: runId, provider: P }, workspaceId },
        create: { workspaceId, payRunId: runId, provider: P, status: "sent", remotePayrollId: payroll.payroll_uuid, sentDigest: run.computeDigest, sentAt: now, sentBy: actor.userId, summary: newSummary as unknown as Prisma.InputJsonValue },
        update: { status: "sent", remotePayrollId: payroll.payroll_uuid, sentDigest: run.computeDigest, sentAt: now, sentBy: actor.userId, summary: newSummary as unknown as Prisma.InputJsonValue },
      });
      await audit(
        tx,
        actor,
        "pay-runs",
        runId,
        authz.kind === "ops_approval" ? "gate_executed" : "gusto_sent",
        `${payRunLabel(run)} sent to Gusto payroll ${payroll.payroll_uuid}: hours for ${plan.sent.length} hourly, ${plan.salaried.length} salaried (paid from Gusto), ${plan.skipped.length} skipped${authz.kind === "ops_approval" ? ` (approval ${authz.approvalId})` : " (confirmed agent tool call)"}`,
      );
      return { outcome: "done", alreadySent: false, payrollId: payroll.payroll_uuid, checkDate: payroll.check_date ?? null, sent: plan.sent.length, salaried: plan.salaried.length, skipped: plan.skipped, warnings: plan.warnings };
    },
    { timeoutMs: TX_TIMEOUT_MS },
  );
}

// ---------------------------------------------------------------------------
// Sync results back (Gusto's taxes and net → payslips; paid → clear net pay)
// ---------------------------------------------------------------------------

export type GustoSyncResult =
  | { outcome: "not_processed"; payrollId: string; deadline: string | null; detail: string }
  | { outcome: "synced"; payrollId: string; changed: boolean; updated: number; removed: string[]; discrepancies: string[]; warnings: string[]; paid: boolean; paymentEntryId: string | null };

const FIGURES: Array<keyof GustoSlipFigures> = ["grossCents", "preTaxDeductionCents", "employeeTaxCents", "postTaxDeductionCents", "netCents", "employerTaxCents", "employerContribCents"];

export async function syncPayRunFromGusto(workspaceId: string, runId: string, auth: GustoAuth, actor: OpsActor, deps: LiveDeps & { now?: () => Date } = {}): Promise<GustoSyncResult> {
  return withWorkspaceScope(
    workspaceId,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll-run:${workspaceId}`}))`;
      const run = await loadPayRun(tx, workspaceId, runId);
      if (run.status === "cancelled") throw new OpsError(409, "This pay run is cancelled");
      const sync = await providerSyncFor(tx, workspaceId, runId);
      if (!sync || sync.provider !== P || !sync.remotePayrollId) throw new OpsError(409, "Send this pay run to Gusto first");
      const payroll = await gustoPayroll(auth, sync.remotePayrollId, deps);
      if (!payroll.processed) {
        return { outcome: "not_processed", payrollId: sync.remotePayrollId, deadline: payroll.payroll_deadline ?? null, detail: "Gusto hasn't processed this payroll yet — review and submit it in Gusto, then sync again." };
      }
      if (payroll.processing_request?.status === "processing_failed") throw new OpsError(409, "Gusto reports that processing this payroll failed — fix it in Gusto, then sync again");

      const links = await confirmedGustoLinks(tx, workspaceId);
      const byEmployee = new Map((payroll.employee_compensations ?? []).filter((c) => !c.excluded).map((c) => [c.employee_uuid, c]));
      const slips = await tx.opsPayslip.findMany({ where: { workspaceId, payRunId: runId }, orderBy: { memberName: "asc" } });
      const warnings: string[] = [];
      const discrepancies: string[] = [];
      const removed: string[] = [];
      const removedIds: string[] = [];
      const figures = new Map<string, GustoSlipFigures>();
      for (const s of slips) {
        const uuid = links.get(s.memberId);
        if (!uuid) {
          warnings.push(`${s.memberName} isn't matched to a Gusto employee — the payslip keeps ShapesOS's own figures.`);
          continue;
        }
        const comp = byEmployee.get(uuid);
        if (!comp) {
          removed.push(s.memberName);
          removedIds.push(s.id);
          continue;
        }
        try {
          figures.set(s.id, payslipFromGusto(comp));
        } catch (err) {
          if (err instanceof GustoMappingError) throw new OpsError(422, `${s.memberName}: ${err.message}`);
          throw err;
        }
      }
      const linkedEmployees = new Set(slips.map((s) => links.get(s.memberId)).filter(Boolean));
      const unmatchedPaid = [...byEmployee.keys()].filter((u) => !linkedEmployees.has(u)).length;
      if (unmatchedPaid) warnings.push(`Gusto paid ${unmatchedPaid} employee(s) who aren't on this run or aren't matched to a team member — their pay isn't in this run.`);

      let changed = false;
      let updated = 0;
      if (run.status === "computed") {
        // The payslips take Gusto's figures; the run's totals and digest follow
        // (any approval requested for the old figures is invalidated).
        for (const s of slips) {
          const f = figures.get(s.id);
          if (!f) continue;
          const same = FIGURES.every((k) => (s as unknown as Record<string, unknown>)[k] === f[k]) && s.taxTable === `gusto:${payroll.payroll_uuid}`;
          if (same) continue;
          await tx.opsPayslip.update({
            where: { id: s.id, workspaceId },
            data: {
              grossCents: f.grossCents,
              preTaxDeductionCents: f.preTaxDeductionCents,
              taxableWagesCents: f.taxableWagesCents,
              employeeTaxCents: f.employeeTaxCents,
              postTaxDeductionCents: f.postTaxDeductionCents,
              netCents: f.netCents,
              employerTaxCents: f.employerTaxCents,
              employerContribCents: f.employerContribCents,
              lines: f.lines as unknown as Prisma.InputJsonValue,
              warnings: f.warnings as unknown as Prisma.InputJsonValue,
              taxTable: `gusto:${payroll.payroll_uuid}`,
            },
          });
          updated += 1;
        }
        if (removed.length) {
          await tx.opsPayslip.deleteMany({ where: { workspaceId, payRunId: runId, id: { in: removedIds } } });
          warnings.push(`Not on Gusto's processed payroll, so Gusto paid them nothing — removed from this run: ${removed.join(", ")}.`);
        }
        changed = updated > 0 || removed.length > 0;
        if (changed) {
          const after = await tx.opsPayslip.findMany({ where: { workspaceId, payRunId: runId } });
          if (after.length === 0) throw new OpsError(422, "None of this run's people are on Gusto's processed payroll — nothing to record");
          const totals = runTotals(after);
          const digest = payRunDigest(run, after.map((s) => ({ ...s, lines: (s.lines as unknown as PayslipLine[]) ?? [] })));
          const moved = await tx.opsPayRun.updateMany({
            where: { id: runId, workspaceId, status: "computed" },
            data: {
              grossCents: totals.grossCents,
              employeeTaxCents: totals.employeeTaxCents,
              deductionCents: totals.deductionCents,
              netCents: totals.netCents,
              employerTaxCents: totals.employerTaxCents,
              employerContribCents: totals.employerContribCents,
              payslipCount: totals.payslipCount,
              computeDigest: digest,
              computedAt: new Date(),
              approvalId: null,
            },
          });
          if (moved.count !== 1) throw new OpsError(409, "The pay run changed concurrently — reload");
          await audit(tx, actor, "pay-runs", runId, "gusto_synced", `${payRunLabel(run)}: taxes and net pay computed by Gusto (payroll ${payroll.payroll_uuid}) — gross ${fmtMoney(totals.grossCents)}, net ${fmtMoney(totals.netCents)}, ${updated} payslip(s) updated${removed.length ? `, ${removed.length} removed` : ""}`);
        }
      } else {
        // Approved / posted: frozen. Only record differences (never touch the
        // payslips or the posted entry).
        for (const s of slips) {
          const f = figures.get(s.id);
          if (!f) continue;
          const diff = FIGURES.filter((k) => (s as unknown as Record<string, unknown>)[k] !== f[k]);
          if (diff.length) discrepancies.push(`${s.memberName}: ${diff.map((k) => `${k.replace(/Cents$/, "")} ${fmtMoney((s as unknown as Record<string, number>)[k]!)} here vs ${fmtMoney(f[k] as number)} in Gusto`).join(", ")}`);
        }
        if (removed.length) discrepancies.push(`Not on Gusto's processed payroll: ${removed.join(", ")}`);
      }

      const now = deps.now?.() ?? new Date();
      const paid = gustoPayrollPaid(payroll, now);
      const prevSummary = (sync.summary ?? {}) as Record<string, unknown>;
      const status = paid ? "paid" : "synced";
      await tx.opsPayRunProviderSync.update({
        where: { id: sync.id, workspaceId },
        data: {
          status,
          syncedAt: sync.syncedAt ?? now,
          ...(paid && !sync.paidAt ? { paidAt: now } : {}),
          remoteCheckDate: payroll.check_date ? new Date(`${payroll.check_date}T00:00:00Z`) : sync.remoteCheckDate,
          summary: { ...prevSummary, lastSync: { at: now.toISOString(), changed, updated, removed, warnings, discrepancies, processedDate: payroll.processed_date ?? null, checkDate: payroll.check_date ?? null } } as unknown as Prisma.InputJsonValue,
        },
      });
      // Paid and posted → clear Net pay payable once.
      const fresh = await providerSyncFor(tx, workspaceId, runId);
      const current = await loadPayRun(tx, workspaceId, runId);
      const paymentEntryId = await clearNetPayIfPaid(tx, actor, current, fresh);
      return { outcome: "synced", payrollId: payroll.payroll_uuid, changed, updated, removed, discrepancies, warnings, paid, paymentEntryId };
    },
    { timeoutMs: TX_TIMEOUT_MS },
  );
}

/**
 * Agent tool gusto.sync_payroll_results (READ ONLY): Gusto's results for a
 * sent run next to the payslips. Writes nothing — a person applies them with
 * "Sync results" on the pay run page (syncPayRunFromGusto).
 */
export async function previewPayRunFromGusto(workspaceId: string, runId: string, auth: GustoAuth, deps: LiveDeps & { now?: () => Date } = {}) {
  const { run, sync, slips, links } = await withWorkspaceScope(workspaceId, async (tx) => ({
    run: await loadPayRun(tx, workspaceId, runId),
    sync: await providerSyncFor(tx, workspaceId, runId),
    slips: await tx.opsPayslip.findMany({ where: { workspaceId, payRunId: runId }, orderBy: { memberName: "asc" } }),
    links: await confirmedGustoLinks(tx, workspaceId),
  }));
  if (!sync || sync.provider !== P || !sync.remotePayrollId) throw new OpsError(409, "This pay run hasn't been sent to Gusto");
  const payroll = await gustoPayroll(auth, sync.remotePayrollId, deps);
  const base = { payRun: payRunLabel(run), runStatus: run.status, gustoStatus: sync.status, payrollId: payroll.payroll_uuid, checkDate: payroll.check_date ?? null };
  if (!payroll.processed) return { ...base, processed: false, deadline: payroll.payroll_deadline ?? null, info: "Not processed yet — the person reviews and submits it in Gusto first." };
  const byEmployee = new Map((payroll.employee_compensations ?? []).map((c) => [c.employee_uuid, c]));
  const people = slips.map((s) => {
    const comp = links.has(s.memberId) ? byEmployee.get(links.get(s.memberId)!) : undefined;
    let gusto: { gross: string; employeeTaxes: string; net: string } | string = links.has(s.memberId) ? "not on Gusto's payroll" : "not matched to Gusto";
    if (comp) {
      try {
        const f = payslipFromGusto(comp);
        gusto = { gross: fmtMoney(f.grossCents), employeeTaxes: fmtMoney(f.employeeTaxCents), net: fmtMoney(f.netCents) };
      } catch (err) {
        gusto = err instanceof Error ? err.message : "unreadable";
      }
    }
    return { name: s.memberName, here: { gross: fmtMoney(s.grossCents), employeeTaxes: fmtMoney(s.employeeTaxCents), net: fmtMoney(s.netCents) }, gusto };
  });
  return { ...base, processed: true, paid: gustoPayrollPaid(payroll, deps.now?.() ?? new Date()), people, info: run.status === "computed" ? "Apply these with Sync results on the pay run page." : "The run is already approved — differences are only recorded." };
}

/** The run's Gusto state for the pay run page (no network). */
export async function gustoRunState(workspaceId: string, runId: string) {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const run = await loadPayRun(tx, workspaceId, runId);
    const sync = await providerSyncFor(tx, workspaceId, runId);
    return { run, sync, stale: !!sync && sync.status === "sent" && sync.sentDigest !== run.computeDigest };
  });
}

/** recordRun wrapper so agent/page actions show in the Business sync run log. */
export function withGustoRun<T>(workspaceId: string, operation: string, actor: string, fn: () => Promise<T>): Promise<T> {
  return recordRun(workspaceId, P, operation, actor, fn);
}
