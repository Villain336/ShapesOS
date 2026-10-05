// Phase 14 (connectors): the Gusto connector — payload mapping against
// Gusto's documented example JSON (fixtures/gusto-docs.ts), idempotency
// keys, the API client's requests (labelled scripted fake), Tier 3 for
// send_payroll_to_provider (never automated, whatever a rule says), mock
// mode and the production no-fakes rule, the OAuth config.
// Live Gusto is UNVERIFIED-LIVE until demo keys exist.
// Run: npx tsx --test lib/bizsync/__tests__/gusto.test.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chunkUpdate, gustoPayrollPaid, hoursString, matchEmployeesByEmail, payslipFromGusto, pickPayrollForPeriod, planPayrollUpdate, sendKey, toCents, GustoMappingError } from "../gusto/map";
import { gustoApiVersion, gustoBaseUrl, gustoEmployees, gustoPayroll, gustoPreparePayroll, gustoUpdatePayroll, GUSTO_DEFAULT_API_VERSION } from "../gusto/api";
import { DOC_EMPLOYEE, DOC_PREPARED_PAYROLL, DOC_PROCESSED_PAYROLL, DOC_TOKEN_INFO, DOC_UNPROCESSED_PAYROLLS, processedComp } from "./fixtures/gusto-docs";
import { jsonResponse, publicResolve, scriptedFetch } from "@/lib/connectors/m21/live/__tests__/fixtures";
import { ConnectorApiError } from "@/lib/connectors/m21/live/http";
import { connectorAction, connectorGroup } from "@/lib/agents/grants";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { decideAutoApproval, validateBehaviorForAction, KNOWN_ACTIONS } from "@/lib/automation/policy";
import { GustoAdapter, gustoAuthFrom } from "@/lib/connectors/m21/native/gusto";
import { resolveAdapter, getBuiltinMeta } from "@/lib/connectors/m21/registry";
import { getOAuthConfig } from "@/lib/vault/oauth";
import type { GustoPayroll } from "../gusto/api";
import type { PayslipLine } from "@/lib/ops/payroll/rules";

const EMP = "187412e1-3dbe-491a-bb2f-2f40323a7067"; // the documented prepare example's employee
const deps = (f: ReturnType<typeof scriptedFetch>) => ({ fetchImpl: f.fetchImpl, resolve: publicResolve, sleep: async () => undefined });
const ENV = ["GUSTO_ENVIRONMENT", "GUSTO_API_VERSION", "NODE_ENV", "ALLOW_FAKE_PROVIDERS"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = saved[k];
  }
});

describe("money and hours", () => {
  it("parses Gusto's decimal strings to exact cents", () => {
    assert.equal(toCents("1953.31"), 195331);
    assert.equal(toCents("0.00"), 0);
    assert.equal(toCents(96.1), 9610);
    assert.equal(toCents("12.345"), 1235);
    assert.equal(toCents("abc"), null);
    assert.equal(toCents(null), null);
    assert.equal(hoursString(645), "10.750");
    assert.equal(hoursString(0), "0.000");
  });
});

describe("employee matching (by email; a person confirms)", () => {
  it("matches the documented employee by email and never guesses duplicates", () => {
    const members = [
      { id: "m1", name: "Boaty", email: "Keena.Feest@kiehn.co.uk" },
      { id: "m2", name: "Twin A", email: "twin@x.test" },
      { id: "m3", name: "Twin B", email: "twin@x.test" },
      { id: "m4", name: "No email", email: null },
    ];
    const emps = [DOC_EMPLOYEE, { uuid: "e-twin", email: "twin@x.test" }, { uuid: "e-work", email: null, work_email: "work@x.test" }];
    const r = matchEmployeesByEmail(members, emps);
    assert.deepEqual(r.matches, [{ memberId: "m1", employeeUuid: DOC_EMPLOYEE.uuid, email: "keena.feest@kiehn.co.uk" }]);
    assert.deepEqual(r.ambiguous, ["twin@x.test"]);
    const w = matchEmployeesByEmail([{ id: "m5", name: "W", email: "WORK@x.test" }], emps);
    assert.deepEqual(w.matches.map((m) => m.employeeUuid), ["e-work"]);
  });
});

const lines = (extra: PayslipLine[] = []): PayslipLine[] => [{ code: "regular", label: "Regular hours", kind: "earning", amountCents: 1, detail: "" }, ...extra];

describe("send: payslips → the documented payroll update", () => {
  it("writes absolute Regular Hours / Overtime with the prepared version and job, in the documented shape", () => {
    const links = new Map([["m-bob", EMP]]);
    const plan = planPayrollUpdate(DOC_PREPARED_PAYROLL as GustoPayroll, [{ memberId: "m-bob", memberName: "Bob", payType: "hourly", regularMinutes: 645, overtimeMinutes: 150, lines: lines() }], links);
    // The documented PUT body: employee_compensations[{ employee_uuid, version, hourly_compensations[{ name, hours, job_uuid }] }].
    assert.deepEqual(plan.body, {
      employee_compensations: [
        {
          employee_uuid: EMP,
          version: "19289df18e6e20f797de4a585ea5a91535c7ddf7",
          hourly_compensations: [
            { name: "Regular Hours", hours: "10.750", job_uuid: "bd378298-3e0c-4145-904a-baadf8a91fa3" },
            { name: "Overtime", hours: "2.500", job_uuid: "9d3760f0-d1f9-4700-8817-0fe2dce5cf23" },
          ],
        },
      ],
    });
    // Fixed compensations (Bonus, Reimbursement) are never in the body: Gusto keeps what isn't sent.
    assert.ok(!JSON.stringify(plan.body).includes("fixed_compensations"));
    assert.deepEqual(plan.skipped, []);
  });

  it("salaried people send nothing (Gusto pays salary from the job); unmatched and excluded people are skipped with a reason", () => {
    const links = new Map([["m-ada", EMP], ["m-exc", "e-exc"]]);
    const prepared = { ...DOC_PREPARED_PAYROLL, employee_compensations: [...DOC_PREPARED_PAYROLL.employee_compensations, { employee_uuid: "e-exc", version: "v", excluded: true, hourly_compensations: [] }] } as GustoPayroll;
    const plan = planPayrollUpdate(
      prepared,
      [
        { memberId: "m-ada", memberName: "Ada", payType: "salary", regularMinutes: 0, overtimeMinutes: 0, lines: [{ code: "allow_phone", label: "Phone", kind: "earning", amountCents: 5000 }, { code: "pre_401k", label: "401(k)", kind: "pre_tax_deduction", amountCents: 100 }] },
        { memberId: "m-new", memberName: "Newbie", payType: "hourly", regularMinutes: 60, overtimeMinutes: 0, lines: lines() },
        { memberId: "m-exc", memberName: "Excluded", payType: "hourly", regularMinutes: 60, overtimeMinutes: 0, lines: lines() },
      ],
      links,
    );
    assert.deepEqual(plan.body.employee_compensations, []);
    assert.deepEqual(plan.salaried, [{ memberName: "Ada", employeeUuid: EMP }]);
    assert.deepEqual(plan.skipped.map((s) => s.memberName), ["Newbie", "Excluded"]);
    assert.match(plan.skipped[0]!.reason, /confirm the match/);
    assert.match(plan.warnings.join(" "), /allowance "Phone" \(\$50\.00\) isn't sent/);
    assert.match(plan.warnings.join(" "), /Deductions and employer contributions aren't sent/);
  });

  it("refuses to guess when Gusto has no Overtime compensation for overtime hours", () => {
    const prepared = { ...DOC_PREPARED_PAYROLL, employee_compensations: [{ ...DOC_PREPARED_PAYROLL.employee_compensations[0]!, hourly_compensations: [DOC_PREPARED_PAYROLL.employee_compensations[0]!.hourly_compensations[0]!] }] } as GustoPayroll;
    const plan = planPayrollUpdate(prepared, [{ memberId: "m", memberName: "Bob", payType: "hourly", regularMinutes: 60, overtimeMinutes: 30, lines: lines() }], new Map([["m", EMP]]));
    assert.equal(plan.body.employee_compensations.length, 0);
    assert.match(plan.skipped[0]!.reason, /no Overtime compensation/);
  });

  it("batches at Gusto's 100-per-request maximum", () => {
    const body = { employee_compensations: Array.from({ length: 205 }, (_, i) => ({ employee_uuid: `e${i}`, version: "v" })) };
    assert.deepEqual(chunkUpdate(body).map((b) => b.employee_compensations.length), [100, 100, 5]);
  });

  it("the idempotency key is stable per run + figures + payroll and changes on a recompute", () => {
    const a = sendKey("run1", "digest-a", "payroll-1");
    assert.equal(a, sendKey("run1", "digest-a", "payroll-1"));
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, sendKey("run1", "digest-b", "payroll-1"));
    assert.notEqual(a, sendKey("run2", "digest-a", "payroll-1"));
    assert.notEqual(a, sendKey("run1", "digest-a", "payroll-2"));
  });

  it("finds the open payroll for exactly the run's period (documented list)", () => {
    assert.equal(pickPayrollForPeriod(DOC_UNPROCESSED_PAYROLLS as GustoPayroll[], "2021-02-01", "2021-02-15").payroll?.payroll_uuid, "b50e611d-8f3d-4f24-b001-46675f7b5777");
    assert.equal(pickPayrollForPeriod(DOC_UNPROCESSED_PAYROLLS as GustoPayroll[], "2021-02-01", "2021-02-14").payroll, null);
    const dup = [...DOC_UNPROCESSED_PAYROLLS, { ...DOC_UNPROCESSED_PAYROLLS[0]!, payroll_uuid: "other" }] as GustoPayroll[];
    assert.deepEqual(pickPayrollForPeriod(dup, "2021-02-01", "2021-02-15"), { payroll: null, ambiguous: true });
  });
});

describe("sync back: a processed employee compensation → payslip figures", () => {
  it("reconciles exactly: net = gross − employee taxes − deductions; employer taxes and contributions kept apart", () => {
    const f = payslipFromGusto(processedComp("e-bob") as never);
    assert.equal(f.grossCents, 155_000);
    assert.equal(f.employeeTaxCents, 26_858);
    assert.equal(f.postTaxDeductionCents, 14_900);
    assert.equal(f.netCents, 113_242);
    assert.equal(f.netCents, f.grossCents - f.preTaxDeductionCents - f.employeeTaxCents - f.postTaxDeductionCents);
    assert.equal(f.taxableWagesCents, f.grossCents - f.preTaxDeductionCents);
    assert.equal(f.employerTaxCents, 12_788);
    assert.equal(f.employerContribCents, 20_000);
    assert.deepEqual(f.lines.filter((l) => l.kind === "earning").map((l) => [l.label, l.amountCents]), [["Regular Hours", 140_000], ["Overtime", 15_000]]);
    assert.ok(f.lines.some((l) => l.kind === "employer_tax" && l.label === "FUTA" && l.amountCents === 930));
    assert.ok(f.warnings.includes("Taxes and net pay computed by Gusto."));
  });

  it("an unexplained difference becomes an 'Other withholdings' line (cash tips, garnishments)", () => {
    const f = payslipFromGusto(processedComp("e", { benefits: [], deductions: [] }) as never);
    assert.equal(f.postTaxDeductionCents, 14_900);
    assert.deepEqual(f.lines.filter((l) => l.code === "gusto_other").map((l) => l.amountCents), [14_900]);
  });

  it("refuses figures that can't reconcile or aren't processed", () => {
    assert.throws(() => payslipFromGusto(processedComp("e", { net_pay: "1500.00" }) as never), GustoMappingError);
    assert.throws(() => payslipFromGusto(processedComp("e", { net_pay: null }) as never), /no gross\/net/);
  });

  it("paid = processed + submitted + check date reached (documented processed example)", () => {
    assert.equal(gustoPayrollPaid(DOC_PROCESSED_PAYROLL as GustoPayroll, new Date("2025-06-13T00:00:00Z")), true);
    assert.equal(gustoPayrollPaid(DOC_PROCESSED_PAYROLL as GustoPayroll, new Date("2025-06-12T23:00:00Z")), false);
    assert.equal(gustoPayrollPaid({ ...DOC_PROCESSED_PAYROLL, processing_request: { status: "processing_failed" } } as GustoPayroll, new Date("2026-01-01")), false);
    assert.equal(gustoPayrollPaid(DOC_UNPROCESSED_PAYROLLS[0] as GustoPayroll, new Date("2030-01-01")), false);
  });
});

describe("API client (labelled scripted fake Gusto)", () => {
  it("demo by default, production only when asked; pinned API version header + Bearer token", async () => {
    delete process.env.GUSTO_ENVIRONMENT;
    assert.equal(gustoBaseUrl(), "https://api.gusto-demo.com");
    process.env.GUSTO_ENVIRONMENT = "production";
    assert.equal(gustoBaseUrl(), "https://api.gusto.com");
    process.env.GUSTO_ENVIRONMENT = "demo";
    assert.equal(gustoApiVersion(), GUSTO_DEFAULT_API_VERSION);
    const f = scriptedFetch([jsonResponse(200, DOC_TOKEN_INFO), jsonResponse(200, [DOC_EMPLOYEE])]);
    const r = await gustoEmployees({ token: "tok" }, deps(f));
    assert.deepEqual(r.items.map((e) => e.uuid), [DOC_EMPLOYEE.uuid]);
    assert.equal(f.calls[0]!.url.href, "https://api.gusto-demo.com/v1/token_info");
    assert.equal(f.calls[1]!.url.pathname, `/v1/companies/${DOC_TOKEN_INFO.resource.uuid}/employees`);
    assert.equal(f.calls[1]!.url.searchParams.get("per"), "100");
    for (const c of f.calls) {
      assert.equal(c.headers.authorization, "Bearer tok");
      assert.equal(c.headers["x-gusto-api-version"], "2026-06-15");
    }
  });

  it("prepare is a PUT with employee_uuids; the update never retries a 409 (re-prepare instead)", async () => {
    const f = scriptedFetch([jsonResponse(200, DOC_PREPARED_PAYROLL), jsonResponse(409, { errors: [{ message: "version mismatch" }] })]);
    const auth = { token: "tok", companyUuid: "c-1" };
    const p = await gustoPreparePayroll(auth, "b50e611d", [EMP], deps(f));
    assert.equal(p.employee_compensations?.[0]?.version, "19289df18e6e20f797de4a585ea5a91535c7ddf7");
    assert.equal(f.calls[0]!.method, "PUT");
    assert.equal(f.calls[0]!.url.pathname, "/v1/companies/c-1/payrolls/b50e611d/prepare");
    assert.deepEqual(f.calls[0]!.body, { employee_uuids: [EMP] });
    await assert.rejects(gustoUpdatePayroll(auth, "b50e611d", { employee_compensations: [] }, deps(f)), (e: unknown) => e instanceof ConnectorApiError && e.status === 409);
    assert.equal(f.remaining(), 0);
    assert.equal(f.calls.length, 2, "no retry after the 409");
  });

  it("reads the processed payroll with include=taxes,benefits,deductions", async () => {
    const f = scriptedFetch([jsonResponse(200, { ...DOC_PROCESSED_PAYROLL, employee_compensations: [processedComp("e1")] })]);
    const p = await gustoPayroll({ token: "t", companyUuid: "c" }, DOC_PROCESSED_PAYROLL.payroll_uuid, deps(f));
    assert.equal(f.calls[0]!.url.searchParams.get("include"), "taxes,benefits,deductions");
    assert.equal(p.employee_compensations?.length, 1);
  });
});

describe("Tier 3: sending payroll to Gusto is never automated", () => {
  const send = new GustoAdapter().listTools().find((t) => t.name === "send_payroll")!;
  it("send_payroll stands for send_payroll_to_provider, which is Tier 3 even with the automation toggle on", () => {
    assert.equal(send.mutating, true);
    assert.equal(connectorAction("gusto", "send_payroll"), "send_payroll_to_provider");
    const action = { kind: "send_payroll_to_provider", description: `${send.name}: ${send.description}` };
    assert.equal(evaluateTier(action, { automationAllows: false, smallActionThresholdCents: 0 }), 3);
    assert.equal(evaluateTier(action, { automationAllows: true, smallActionThresholdCents: 1_000_000_00 }), 3);
    assert.equal(KNOWN_ACTIONS.find((a) => a.action === "send_payroll_to_provider")?.tier, 3);
  });

  it("an 'auto' rule for it is refused, and even a stored one never auto-approves", () => {
    assert.match(String(validateBehaviorForAction("send_payroll_to_provider", "auto", null)), /not allowed for Tier 3/);
    for (const agentKey of ["lead", "*"]) {
      const d = decideAutoApproval([{ agentKey: "*", action: "send_payroll_to_provider", behavior: "auto", thresholdCents: 1_000_000_00 }, { agentKey: "*", action: "*", behavior: "auto", thresholdCents: 1_000_000_00 }], { agentKey, action: "send_payroll_to_provider", description: `${send.name}: ${send.description}` });
      assert.equal(d.auto, false);
      assert.equal(d.tier, 3);
    }
  });

  it("the other Gusto tools: sync_employees is a Tier-2 write; the reads are read-only; the group is ops", () => {
    assert.equal(connectorAction("gusto", "sync_employees"), "write_gusto");
    assert.equal(evaluateTier({ kind: "write_gusto", description: "sync_employees" }, { automationAllows: true, smallActionThresholdCents: 0 }), 2);
    const tools = Object.fromEntries(new GustoAdapter().listTools().map((t) => [t.name, t.mutating]));
    assert.deepEqual(tools, { list_employees: false, sync_employees: true, send_payroll: true, sync_payroll_results: false });
    assert.equal(connectorGroup("gusto"), "ops");
  });
});

describe("adapter: mock mode and production", () => {
  const ctx = { workspaceId: "ws", userId: "u" };
  it("without a credential: labelled mocks that send nothing (dev/test)", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    const a = resolveAdapter("gusto");
    for (const tool of ["list_employees", "sync_employees", "send_payroll", "sync_payroll_results"]) {
      const r = await a.invoke(tool, { payRunId: "r1" }, null, ctx);
      assert.equal(r.ok, true, tool);
      assert.equal(r.mock, true, tool);
    }
    const s = await a.invoke("send_payroll", { payRunId: "r1" }, null, ctx);
    assert.match(JSON.stringify(s.data), /MOCK — Gusto is not connected; nothing was sent/);
  });

  it("in production without a credential: 'not connected', never mock data", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.ALLOW_FAKE_PROVIDERS;
    const r = await resolveAdapter("gusto").invoke("send_payroll", { payRunId: "r1" }, null, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "not_connected");
  });

  it("reads the token and an optional company id from the credential", () => {
    assert.equal(gustoAuthFrom(null), null);
    const a = gustoAuthFrom({ kind: "oauth2", payload: { access_token: "t", company_uuid: "c-9" } });
    assert.equal(a?.token, "t");
    assert.equal(a?.companyUuid, "c-9");
  });
});

describe("registry + OAuth config", () => {
  it("Gusto is the 27th built-in, OAuth2 with the documented endpoints for the chosen environment", () => {
    const meta = getBuiltinMeta("gusto");
    assert.equal(meta.authType, "oauth2");
    assert.deepEqual(meta.oauth?.envVars, ["GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET"]);
    delete process.env.GUSTO_ENVIRONMENT;
    const cfg = getOAuthConfig("gusto")!;
    assert.equal(cfg.authorizeUrl, "https://api.gusto-demo.com/oauth/authorize");
    assert.equal(cfg.tokenUrl, "https://api.gusto-demo.com/oauth/token");
    assert.equal(cfg.tokenRequest, "json");
    assert.equal(cfg.refreshWithRedirectUri, true);
    process.env.GUSTO_ENVIRONMENT = "production";
    assert.equal(getOAuthConfig("gusto")!.tokenUrl, "https://api.gusto.com/oauth/token");
  });
});
