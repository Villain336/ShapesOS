// Phase 14 (connectors): the Gusto payroll flow on real Postgres, as the
// least-privilege app role, against a labelled FAKE Gusto (documented
// shapes: lib/bizsync/__tests__/fixtures/gusto-docs.ts; live Gusto is
// UNVERIFIED-LIVE until demo keys exist):
//   1. employee links: email matches are only SUGGESTIONS; a person confirms;
//      only confirmed links are used; biz_sync_links + the new
//      ops_pay_run_provider_syncs are FORCE RLS;
//   2. Tier 3 through the gates: the chat connector gate never auto-runs
//      gusto.send_payroll even with an "auto" rule; the pay-run page path
//      needs an OPS_PAYROLL_SEND_PROVIDER approval decided by a person;
//   3. the send writes the documented update and is idempotent per run +
//      figures (repeat = no Gusto call; a recompute needs a new approval);
//   4. approve/post are refused until Gusto's results are synced; sync before
//      processing changes nothing; sync after: payslips + totals carry
//      Gusto's taxes and net ("computed by Gusto"), recompute refused;
//   5. post uses Gusto's figures; after posting nothing on the run or its
//      entry changes (differences are recorded); when Gusto has paid, ONE
//      balanced payment entry clears Net pay payable, once.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=<app role> MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/bizsync/__tests__/gusto-payroll-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { decideApproval } from "@/lib/integrations/actions/gate";
import { OPS_ENTITY_MAP } from "@/lib/ops/entities";
import { OpsError, opsCreate, type OpsActor } from "@/lib/ops/doctype";
import { OpsGateError } from "@/lib/ops/gate";
import { findEntryBySource } from "@/lib/ops/accounting";
import { approvePayRun, computePayRun, postPayRun } from "@/lib/ops/payroll/runs";
import { publicResolve } from "@/lib/connectors/m21/live/__tests__/fixtures";
import { confirmedGustoLinks, sendPayRunToGusto, setGustoEmployeeLink, suggestGustoLinks, syncPayRunFromGusto, previewPayRunFromGusto } from "../gusto/payroll";
import { gustoEmployees, type GustoEmployee } from "../gusto/api";
import { DOC_TOKEN_INFO, processedComp } from "./fixtures/gusto-docs";
import { resolveConnectorTool } from "@/lib/chat/connector-tools";

process.env.MARKETR_CREDENTIALS_KEY ??= "c".repeat(64);
const RUN = `p14g-${Date.now().toString(36)}`;
const WS = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const OWNER = `${RUN}-owner`;
const ADMIN: OpsActor = { workspaceId: WS, userId: `${RUN}-admin` };
const BOB_USER = `${RUN}-bob`;
const CY_USER = `${RUN}-cy`;
const COMPANY = DOC_TOKEN_INFO.resource.uuid;
const PR = "pr-0001-aaaa-bbbb";
const E = { ada: "e-ada-0001", bob: "e-bob-0001", zed: "e-zed-0001" };
const def = (slug: string) => OPS_ENTITY_MAP[slug]!;
const rowOf = (r: unknown) => (r as { row: Record<string, unknown> }).row;
const create = async (actor: OpsActor, slug: string, body: Record<string, unknown>) => rowOf(await withWorkspaceScope(actor.workspaceId, (tx) => opsCreate(tx, def(slug), actor, body)));
const ids = { ada: "", bob: "", cy: "", run: "" };
const run = () => withWorkspaceScope(WS, (tx) => tx.opsPayRun.findFirstOrThrow({ where: { id: ids.run, workspaceId: WS } }));
const slips = () => withWorkspaceScope(WS, (tx) => tx.opsPayslip.findMany({ where: { workspaceId: WS, payRunId: ids.run }, orderBy: { memberName: "asc" } }));
const syncRow = () => withWorkspaceScope(WS, (tx) => tx.opsPayRunProviderSync.findFirst({ where: { workspaceId: WS, payRunId: ids.run } }));

// ---------------------------------------------------------------------------
// FAKE Gusto (tests only) — routed by method + path, documented shapes.
// ---------------------------------------------------------------------------
const gusto = {
  processed: false,
  checkDate: "2099-03-20",
  version: 1,
  updates: [] as Array<Record<string, unknown>>,
  prepares: 0,
  bobNet: "1132.42",
};
const EMPLOYEES: GustoEmployee[] = [
  { uuid: E.ada, first_name: "Ada", last_name: "Salaried", email: "ada@x.test", terminated: false },
  { uuid: E.bob, first_name: "Bob", last_name: "Hourly", email: "BOB@x.test", terminated: false },
  { uuid: E.zed, first_name: "Zed", last_name: "Elsewhere", email: "zed@x.test", terminated: false },
];
const hourly = (uuid: string) => ({
  employee_uuid: uuid,
  version: `v${gusto.version}-${uuid}`,
  excluded: false,
  fixed_compensations: [{ name: "Bonus", amount: "0.00", job_uuid: `job-${uuid}` }],
  hourly_compensations: [
    { name: "Regular Hours", hours: "0.000", job_uuid: `job-${uuid}`, compensation_multiplier: 1 },
    { name: "Overtime", hours: "0.000", job_uuid: `job-${uuid}`, compensation_multiplier: 1.5 },
  ],
});
const fakeGusto = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  assert.equal(url.host, "api.gusto-demo.com", "demo host by default");
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer gusto-token");
  assert.equal(new Headers(init?.headers).get("x-gusto-api-version"), "2026-06-15");
  const p = url.pathname;
  if (p === "/v1/token_info") return json(DOC_TOKEN_INFO);
  if (p === `/v1/companies/${COMPANY}/employees`) return json(EMPLOYEES);
  if (p === `/v1/companies/${COMPANY}/payrolls` && method === "GET") {
    assert.equal(url.searchParams.get("processing_statuses"), "unprocessed");
    assert.equal(url.searchParams.get("payroll_types"), "regular");
    return json(gusto.processed ? [] : [{ payroll_uuid: PR, processed: false, check_date: gusto.checkDate, payroll_deadline: "2099-03-18T20:00:00Z", pay_period: { start_date: "2026-03-02", end_date: "2026-03-15" } }]);
  }
  if (p === `/v1/companies/${COMPANY}/payrolls/${PR}/prepare` && method === "PUT") {
    gusto.prepares += 1;
    const body = JSON.parse(String(init?.body)) as { employee_uuids: string[] };
    return json({ payroll_uuid: PR, processed: false, pay_period: { start_date: "2026-03-02", end_date: "2026-03-15" }, employee_compensations: body.employee_uuids.map(hourly) });
  }
  if (p === `/v1/companies/${COMPANY}/payrolls/${PR}` && method === "PUT") {
    const body = JSON.parse(String(init?.body)) as { employee_compensations: Array<{ version: string; employee_uuid: string }> };
    for (const c of body.employee_compensations) if (c.version !== `v${gusto.version}-${c.employee_uuid}`) return json({ errors: [{ message: "version" }] }, 409);
    gusto.updates.push(body);
    gusto.version += 1;
    return json({ payroll_uuid: PR, employee_compensations: body.employee_compensations });
  }
  if (p === `/v1/companies/${COMPANY}/payrolls/${PR}` && method === "GET") {
    assert.equal(url.searchParams.get("include"), "taxes,benefits,deductions");
    if (!gusto.processed) return json({ payroll_uuid: PR, processed: false, payroll_deadline: "2099-03-18T20:00:00Z", pay_period: { start_date: "2026-03-02", end_date: "2026-03-15" } });
    return json({
      payroll_uuid: PR,
      processed: true,
      processed_date: "2026-03-18",
      check_date: gusto.checkDate,
      processing_request: { status: "submit_success", errors: [] },
      pay_period: { start_date: "2026-03-02", end_date: "2026-03-15" },
      employee_compensations: [
        {
          employee_uuid: E.ada,
          excluded: false,
          gross_pay: "2000.00",
          net_pay: "1450.00",
          check_amount: "1450.00",
          fixed_compensations: [],
          hourly_compensations: [],
          taxes: [
            { name: "Federal Income Tax", employer: false, amount: "300.00" },
            { name: "Social Security", employer: false, amount: "124.00" },
            { name: "Medicare", employer: false, amount: "29.00" },
            { name: "Social Security", employer: true, amount: "124.00" },
            { name: "Medicare", employer: true, amount: "29.00" },
          ],
          benefits: [{ name: "401(k)", employee_deduction: "97.00", company_contribution: "60.00" }],
          deductions: [],
        },
        processedComp(E.bob, { net_pay: gusto.bobNet, check_amount: gusto.bobNet, deductions: gusto.bobNet === "1132.42" ? [{ name: "Garnishment", amount: "49.00" }] : [] }),
        processedComp(E.zed),
      ],
    });
  }
  throw new Error(`fake Gusto: unexpected ${method} ${p}`);
}) as typeof fetch;
const deps = { fetchImpl: fakeGusto, resolve: publicResolve, sleep: async () => undefined };
const auth = () => ({ token: "gusto-token" });

async function ws(id: string, owner: string) {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${owner}, now())`;
}

before(async () => {
  delete process.env.GUSTO_ENVIRONMENT;
  delete process.env.GUSTO_API_VERSION;
  await ws(WS, OWNER);
  await ws(WS_B, `${RUN}-b-owner`);
  await withWorkspaceScope(WS, async (tx) => {
    ids.ada = (await tx.opsTeamMember.create({ data: { workspaceId: WS, name: "Ada Salaried", email: "ada@x.test" } })).id;
    ids.bob = (await tx.opsTeamMember.create({ data: { workspaceId: WS, name: "Bob Hourly", email: "bob@x.test", userId: BOB_USER } })).id;
    ids.cy = (await tx.opsTeamMember.create({ data: { workspaceId: WS, name: "Cy Unmatched", userId: CY_USER } })).id;
  });
  const project = String((await create(ADMIN, "projects", { name: "Client work" })).id);
  const salaried = String((await create(ADMIN, "salary-structures", { name: "Salaried", payType: "salary", payFrequency: "biweekly", annualSalaryCents: 5_200_000, components: [{ code: "401k", label: "401(k)", kind: "pre_tax_deduction", calc: "percent", rateBps: 500 }] })).id);
  const hourly = String((await create(ADMIN, "salary-structures", { name: "Hourly", payType: "hourly", payFrequency: "biweekly", hourlyRateCents: 2_000 })).id);
  await create(ADMIN, "salary-assignments", { memberId: ids.ada, structureId: salaried, effectiveFrom: "2026-01-01", stateCode: "IL" });
  await create(ADMIN, "salary-assignments", { memberId: ids.bob, structureId: hourly, effectiveFrom: "2026-01-01" });
  await create(ADMIN, "salary-assignments", { memberId: ids.cy, structureId: hourly, effectiveFrom: "2026-01-01" });
  await withWorkspaceScope(WS, async (tx) => {
    const t = (userId: string, day: string, minutes: number) => tx.opsTimeEntry.create({ data: { workspaceId: WS, projectId: project, userId, minutes, occurredAt: new Date(`${day}T15:00:00Z`), approvalStatus: "approved" } });
    for (const d of ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"]) await t(BOB_USER, d, 540); // 45 h
    await t(BOB_USER, "2026-03-09", 900);
    await t(BOB_USER, "2026-03-10", 900); // 30 h
    await t(CY_USER, "2026-03-03", 600);
  });
  ids.run = String((await create(ADMIN, "pay-runs", { periodStart: "2026-03-02", periodEnd: "2026-03-15", payDate: "2026-03-20" })).id);
  await withWorkspaceScope(WS, (tx) => computePayRun(tx, ADMIN, ids.run));
});

after(async () => {
  await prisma.connectorConnection.deleteMany({ where: { workspaceId: WS } });
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS_B}`;
  await prisma.$disconnect();
});

describe("Gusto employee links", () => {
  it("email matches are only suggestions; nothing is confirmed by the agent tool", async () => {
    const r = await suggestGustoLinks(WS, auth(), ADMIN.userId, deps);
    assert.equal(r.suggested, 2); // Ada + Bob (case-insensitive email); Cy has no email; Zed isn't a member
    assert.equal(r.unmatchedMembers, 1);
    assert.equal(r.unmatchedEmployees, 1);
    assert.equal((await withWorkspaceScope(WS, (tx) => confirmedGustoLinks(tx, WS))).size, 0);
    const again = await suggestGustoLinks(WS, auth(), ADMIN.userId, deps);
    assert.equal(again.suggested, 0);
    assert.equal(again.alreadyLinked, 2);
  });

  it("a person confirms; links to unknown employees or already-linked members are refused", async () => {
    const emps = (await gustoEmployees(auth(), deps)).items;
    await setGustoEmployeeLink(WS, E.ada, ids.ada, OWNER, emps);
    await setGustoEmployeeLink(WS, E.bob, ids.bob, OWNER, emps);
    await assert.rejects(setGustoEmployeeLink(WS, "e-nobody-01", ids.cy, OWNER, emps), /isn't in the connected company/);
    await assert.rejects(setGustoEmployeeLink(WS, E.zed, ids.bob, OWNER, emps), /already linked/);
    const links = await withWorkspaceScope(WS, (tx) => confirmedGustoLinks(tx, WS));
    assert.deepEqual(Object.fromEntries(links), { [ids.ada]: E.ada, [ids.bob]: E.bob });
  });

  it("links are FORCE RLS: another workspace (and no scope) sees none", async () => {
    assert.equal(await withWorkspaceScope(WS_B, (tx) => tx.bizSyncLink.count({ where: { provider: "gusto" } })), 0);
    assert.equal(await prisma.bizSyncLink.count({ where: { provider: "gusto" } }), 0);
    await assert.rejects(withWorkspaceScope(WS_B, (tx) => tx.bizSyncLink.create({ data: { workspaceId: WS, provider: "gusto", objectType: "employee", remoteId: "x", localId: "y" } })));
  });
});

describe("Tier 3: sending payroll always asks", () => {
  it("the chat connector gate never auto-runs gusto.send_payroll, even with an 'auto' rule for it", async () => {
    const projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } })).id;
    const conn = await prisma.connectorConnection.create({ data: { workspaceId: WS, userId: ADMIN.userId, connectorKey: "gusto", status: "active", scopes: [] } });
    await prisma.projectDataSource.create({ data: { projectId, connectionId: conn.id, connectorKey: "gusto" } });
    // A rule stored directly (the settings API refuses auto for Tier 3).
    await withWorkspaceScope(WS, async (tx) => {
      await tx.automationSetting.create({ data: { workspaceId: WS, agentKey: "*", action: "send_payroll_to_provider", behavior: "auto", updatedBy: OWNER } });
      await tx.automationSetting.create({ data: { workspaceId: WS, agentKey: "*", action: "*", behavior: "auto", updatedBy: OWNER } });
    });
    const before = gusto.updates.length;
    const out = await resolveConnectorTool("connector.gusto.send_payroll", { projectId, workspaceId: WS, userId: ADMIN.userId, role: "owner", confirmed: false, agentKey: "lead" }, { payRunId: ids.run });
    assert.equal(out.status, "pending_confirmation");
    assert.equal((out as { autoAction?: string }).autoAction, undefined, "the chat must not even offer 'do this without asking'");
    assert.equal(gusto.updates.length, before, "nothing reached Gusto");
    assert.equal(await syncRow(), null);
  });

  it("the pay run page path needs an OPS_PAYROLL_SEND_PROVIDER approval decided by a person", async () => {
    const p = await sendPayRunToGusto(WS, ids.run, auth(), ADMIN, { kind: "ops_approval", approvalId: undefined }, deps);
    assert.equal(p.outcome, "approval_required");
    assert.equal(gusto.updates.length, 0);
    const approvalId = (p as { approval: { id: string } }).approval.id;
    await assert.rejects(sendPayRunToGusto(WS, ids.run, auth(), ADMIN, { kind: "ops_approval", approvalId }, deps), (e: unknown) => e instanceof OpsGateError, "not decided yet");
    await assert.rejects(sendPayRunToGusto(WS, ids.run, auth(), ADMIN, { kind: "ops_approval", approvalId: "made-up" }, deps), (e: unknown) => e instanceof OpsGateError);
    assert.equal(gusto.updates.length, 0);
    await decideApproval({ workspaceId: WS, approvalId, decision: "approved", decidedBy: OWNER });
    const done = await sendPayRunToGusto(WS, ids.run, auth(), ADMIN, { kind: "ops_approval", approvalId }, deps);
    assert.equal(done.outcome, "done");
    assert.equal((done as { alreadySent: boolean }).alreadySent, false);
    const approval = await withWorkspaceScope(WS, (tx) => tx.composioActionApproval.findFirstOrThrow({ where: { id: approvalId, workspaceId: WS } }));
    assert.equal(approval.status, "executed");
    assert.equal(approval.decidedBy, OWNER);
  });
});

describe("send to Gusto", () => {
  it("wrote Bob's hours (documented shape); Ada is salaried (Gusto pays her salary); Cy is skipped (not matched)", async () => {
    assert.equal(gusto.updates.length, 1);
    assert.deepEqual(gusto.updates[0], {
      employee_compensations: [
        {
          employee_uuid: E.bob,
          version: `v1-${E.bob}`,
          hourly_compensations: [
            { name: "Regular Hours", hours: "70.000", job_uuid: `job-${E.bob}` },
            { name: "Overtime", hours: "5.000", job_uuid: `job-${E.bob}` },
          ],
        },
      ],
    });
    const s = await syncRow();
    assert.equal(s?.status, "sent");
    assert.equal(s?.remotePayrollId, PR);
    assert.equal(s?.sentDigest, (await run()).computeDigest);
    const summary = s?.summary as { salaried: Array<{ memberName: string }>; skipped: Array<{ memberName: string }>; sendKey: string };
    assert.deepEqual(summary.salaried.map((x) => x.memberName), ["Ada Salaried"]);
    assert.deepEqual(summary.skipped.map((x) => x.memberName), ["Cy Unmatched"]);
    assert.match(summary.sendKey, /^[0-9a-f]{64}$/);
  });

  it("is idempotent per run + figures: a repeat (any path) calls Gusto for nothing", async () => {
    const prepares = gusto.prepares;
    const a = await sendPayRunToGusto(WS, ids.run, auth(), ADMIN, { kind: "confirmed_tool_call" }, deps);
    const b = await sendPayRunToGusto(WS, ids.run, auth(), ADMIN, { kind: "ops_approval", approvalId: undefined }, deps);
    for (const r of [a, b]) {
      assert.equal(r.outcome, "done");
      assert.equal((r as { alreadySent: boolean }).alreadySent, true);
    }
    assert.equal(gusto.updates.length, 1);
    assert.equal(gusto.prepares, prepares, "no Gusto call at all");
    // An identical recompute keeps the digest — still already sent.
    await withWorkspaceScope(WS, (tx) => computePayRun(tx, ADMIN, ids.run));
    const c = await sendPayRunToGusto(WS, ids.run, auth(), ADMIN, { kind: "confirmed_tool_call" }, deps);
    assert.equal((c as { alreadySent: boolean }).alreadySent, true);
  });

  it("new figures (a recompute) need a new approval and send again with absolute hours", async () => {
    await withWorkspaceScope(WS, async (tx) => {
      const project = (await tx.opsTimeEntry.findFirstOrThrow({ where: { workspaceId: WS, userId: BOB_USER } })).projectId;
      await tx.opsTimeEntry.create({ data: { workspaceId: WS, projectId: project, userId: BOB_USER, minutes: 60, occurredAt: new Date("2026-03-11T15:00:00Z"), approvalStatus: "approved" } });
    });
    await withWorkspaceScope(WS, (tx) => computePayRun(tx, ADMIN, ids.run));
    const p = await sendPayRunToGusto(WS, ids.run, auth(), ADMIN, { kind: "ops_approval", approvalId: undefined }, deps);
    assert.equal(p.outcome, "approval_required", "a recompute is new figures: it asks again");
    const approvalId = (p as { approval: { id: string } }).approval.id;
    await decideApproval({ workspaceId: WS, approvalId, decision: "approved", decidedBy: OWNER });
    await sendPayRunToGusto(WS, ids.run, auth(), ADMIN, { kind: "ops_approval", approvalId }, deps);
    assert.equal(gusto.updates.length, 2);
    const hours = (gusto.updates[1] as { employee_compensations: Array<{ hourly_compensations: Array<{ hours: string }> }> }).employee_compensations[0]!.hourly_compensations.map((h) => h.hours);
    assert.deepEqual(hours, ["71.000", "5.000"], "absolute hours for the period, not an increment");
  });
});

describe("approve / post wait for Gusto's results; sync back", () => {
  it("approving or posting a sent-but-unsynced run is refused", async () => {
    await assert.rejects(withWorkspaceScope(WS, (tx) => approvePayRun(tx, ADMIN, ids.run, undefined)), (e: unknown) => e instanceof OpsError && e.status === 409 && /Sync results/.test(e.message));
  });

  it("sync before Gusto processed it changes nothing", async () => {
    const before = await slips();
    const r = await syncPayRunFromGusto(WS, ids.run, auth(), ADMIN, deps);
    assert.equal(r.outcome, "not_processed");
    assert.deepEqual((await slips()).map((s) => s.netCents), before.map((s) => s.netCents));
    assert.equal((await syncRow())?.status, "sent");
    const preview = await previewPayRunFromGusto(WS, ids.run, auth(), deps);
    assert.equal(preview.processed, false);
  });

  it("after the person submits in Gusto: payslips and totals carry Gusto's taxes and net", async () => {
    gusto.processed = true;
    const beforeDigest = (await run()).computeDigest;
    const preview = await previewPayRunFromGusto(WS, ids.run, auth(), deps);
    assert.equal(preview.processed, true);
    assert.equal((await slips()).find((s) => s.memberId === ids.ada)?.netCents === 145_000, false, "the read-only preview wrote nothing");

    const r = await syncPayRunFromGusto(WS, ids.run, auth(), ADMIN, deps);
    assert.equal(r.outcome, "synced");
    const res = r as { changed: boolean; updated: number; paid: boolean; warnings: string[] };
    assert.equal(res.changed, true);
    assert.equal(res.updated, 2);
    assert.equal(res.paid, false, "check date not reached");
    assert.ok(res.warnings.some((w) => /Cy Unmatched isn't matched/.test(w)));
    assert.ok(res.warnings.some((w) => /Gusto paid 1 employee/.test(w)), "Zed is reported, not added");
    const all = await slips();
    const ada = all.find((s) => s.memberId === ids.ada)!;
    assert.deepEqual([ada.grossCents, ada.employeeTaxCents, ada.postTaxDeductionCents, ada.netCents, ada.employerTaxCents, ada.employerContribCents], [200_000, 45_300, 9_700, 145_000, 15_300, 6_000]);
    assert.equal(ada.taxTable, `gusto:${PR}`);
    const bob = all.find((s) => s.memberId === ids.bob)!;
    assert.deepEqual([bob.grossCents, bob.employeeTaxCents, bob.netCents], [155_000, 26_858, 113_242]);
    const cy = all.find((s) => s.memberId === ids.cy)!;
    assert.notEqual(cy.taxTable.startsWith("gusto:"), true, "unmatched keeps ShapesOS's figures");
    const r2 = await run();
    assert.equal(r2.grossCents, all.reduce((s, p) => s + p.grossCents, 0));
    assert.equal(r2.netCents, all.reduce((s, p) => s + p.netCents, 0));
    assert.equal(r2.employeeTaxCents, all.reduce((s, p) => s + p.employeeTaxCents, 0));
    assert.notEqual(r2.computeDigest, beforeDigest);
    assert.equal((await syncRow())?.status, "synced");
    // A recompute would replace what Gusto paid → refused.
    await assert.rejects(withWorkspaceScope(WS, (tx) => computePayRun(tx, ADMIN, ids.run)), /computed and paid/);
    // A repeat sync is a no-op.
    const again = await syncPayRunFromGusto(WS, ids.run, auth(), ADMIN, deps);
    assert.equal((again as { changed: boolean }).changed, false);
  });

  it("approve + post through the gates use Gusto's figures", async () => {
    const a1 = await withWorkspaceScope(WS, (tx) => approvePayRun(tx, ADMIN, ids.run, undefined));
    const aid = (a1 as { approval: { id: string } }).approval.id;
    await decideApproval({ workspaceId: WS, approvalId: aid, decision: "approved", decidedBy: OWNER });
    await withWorkspaceScope(WS, (tx) => approvePayRun(tx, ADMIN, ids.run, aid));
    const p1 = await withWorkspaceScope(WS, (tx) => postPayRun(tx, ADMIN, ids.run, undefined));
    const pid = (p1 as { approval: { id: string } }).approval.id;
    await decideApproval({ workspaceId: WS, approvalId: pid, decision: "approved", decidedBy: OWNER });
    await withWorkspaceScope(WS, (tx) => postPayRun(tx, ADMIN, ids.run, pid));
    const r = await run();
    assert.equal(r.status, "posted");
    const entry = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `pay_run:${ids.run}:post`));
    const by = Object.fromEntries(entry!.lines.map((l) => [l.accountCode, l.debitCents || -l.creditCents]));
    assert.equal(by["2310"], -r.netCents, "Net pay payable = Gusto's net (+ Cy's own)");
    assert.equal(by["6700"], r.grossCents);
    assert.equal((await syncRow())?.paymentEntryId, null, "not paid yet");
  });

  it("after posting, a changed Gusto figure is only recorded — payslips and the posted entry stay", async () => {
    const entryBefore = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `pay_run:${ids.run}:post`));
    const slipsBefore = await slips();
    gusto.bobNet = "1181.42"; // a different net from Gusto (deductions dropped)
    const r = await syncPayRunFromGusto(WS, ids.run, auth(), ADMIN, deps);
    const res = r as { changed: boolean; discrepancies: string[] };
    assert.equal(res.changed, false);
    assert.ok(res.discrepancies.some((d) => /Bob Hourly: .*net/.test(d)));
    assert.deepEqual((await slips()).map((s) => [s.id, s.netCents]), slipsBefore.map((s) => [s.id, s.netCents]));
    const entryAfter = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `pay_run:${ids.run}:post`));
    assert.deepEqual(entryAfter, entryBefore);
    gusto.bobNet = "1132.42";
  });

  it("when Gusto has paid: ONE balanced payment entry clears Net pay payable, once", async () => {
    gusto.checkDate = "2026-03-20"; // in the past now
    const r1 = await syncPayRunFromGusto(WS, ids.run, auth(), ADMIN, deps);
    const res = r1 as { paid: boolean; paymentEntryId: string | null };
    assert.equal(res.paid, true);
    assert.ok(res.paymentEntryId);
    const run1 = await run();
    const pay = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `pay_run:${ids.run}:net_pay_paid`));
    assert.equal(pay!.id, res.paymentEntryId);
    const by = Object.fromEntries(pay!.lines.map((l) => [l.accountCode, l.debitCents || -l.creditCents]));
    assert.deepEqual(by, { "2310": run1.netCents, "1000": -run1.netCents });
    assert.equal(pay!.lines.reduce((s, l) => s + l.debitCents, 0), pay!.lines.reduce((s, l) => s + l.creditCents, 0), "balanced");
    const s = await syncRow();
    assert.equal(s?.status, "paid");
    assert.equal(s?.paymentEntryId, pay!.id);
    // Again: no second entry.
    const r2 = await syncPayRunFromGusto(WS, ids.run, auth(), ADMIN, deps);
    assert.equal((r2 as { paymentEntryId: string }).paymentEntryId, pay!.id);
    const n = await withWorkspaceScope(WS, (tx) => tx.opsJournalEntry.count({ where: { workspaceId: WS, sourceKey: `pay_run:${ids.run}:net_pay_paid` } }));
    assert.equal(n, 1);
    // Net pay payable for this run nets to zero across the two entries.
    const post = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `pay_run:${ids.run}:post`));
    const net2310 = [...post!.lines, ...pay!.lines].filter((l) => l.accountCode === "2310").reduce((t, l) => t + l.debitCents - l.creditCents, 0);
    assert.equal(net2310, 0);
  });

  it("ops_pay_run_provider_syncs is FORCE RLS and its states are DB-checked", async () => {
    assert.equal(await prisma.opsPayRunProviderSync.count(), 0, "no scope sees nothing");
    assert.equal(await withWorkspaceScope(WS_B, (tx) => tx.opsPayRunProviderSync.count()), 0);
    assert.equal(await withWorkspaceScope(WS, (tx) => tx.opsPayRunProviderSync.count()), 1);
    const id = (await syncRow())!.id;
    await assert.rejects(withWorkspaceScope(WS, (tx) => tx.$executeRawUnsafe(`UPDATE ops_pay_run_provider_syncs SET status = 'refunded' WHERE id = $1`, id)), /check/i);
    await assert.rejects(withWorkspaceScope(WS, (tx) => tx.$executeRawUnsafe(`UPDATE ops_pay_run_provider_syncs SET status = 'paid', paid_at = NULL WHERE id = $1`, id)), /check/i);
  });
});
