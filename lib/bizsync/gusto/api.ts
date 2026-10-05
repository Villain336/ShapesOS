// ShapesOS — Phase 14 (connectors): Gusto App Integrations API calls.
//
// Verified 2026-10-05 against docs.gusto.com/app-integrations:
//   OAuth2        docs/oauth2 — authorize https://api.gusto.com/oauth/authorize,
//                 token https://api.gusto.com/oauth/token (JSON body with the
//                 client credentials; access tokens last 2 h; a refresh token
//                 is single-use and rotates). Demo: the same paths on
//                 https://api.gusto-demo.com. Since v2023-05-01 ("strict
//                 access") a token covers exactly ONE company.
//   Versioning    docs/api-versioning — header X-Gusto-API-Version (date
//                 version; the reference pages list 2026-06-15). Without it
//                 Gusto uses the app's minimum version.
//   Scopes        docs/scopes — assigned per app by Gusto during review
//                 (not requested on the authorize URL). This integration
//                 needs employees:read, payrolls:read, payrolls:write.
//   Company       GET /v1/token_info → { resource: { type: "Company", uuid } }
//   Employees     GET /v1/companies/{company_id}/employees?page=&per=
//   Payrolls      docs/updating-payrolls —
//                 GET  /v1/companies/{id}/payrolls?processing_statuses=unprocessed
//                      &payroll_types=regular&start_date=&end_date=
//                 PUT  /v1/companies/{id}/payrolls/{payroll_id}/prepare
//                      → employee_compensations[] each with its own `version`
//                 PUT  /v1/companies/{id}/payrolls/{payroll_id}
//                      { employee_compensations: [{ employee_uuid, version,
//                        hourly_compensations: [{ name, hours, job_uuid }] }] }
//                      (max 100 per request; compensations not sent are kept;
//                      a stale version answers 409 — re-prepare, never blindly
//                      copy the new version)
//                 GET  /v1/companies/{id}/payrolls/{payroll_id}?include=taxes,benefits,deductions
//                      → processed: employee_compensations[] with gross_pay,
//                        net_pay, check_amount, taxes[{ name, employer, amount }],
//                        benefits[{ name, employee_deduction, company_contribution }],
//                        deductions[{ name, amount }]
//                 "Can we process payroll through the API? No … this should be
//                 done in Gusto to allow the user to review and confirm." —
//                 ShapesOS never submits a payroll; the person does, in Gusto.
//
// Transport is liveRequest (safeFetch, closed error codes, token scrubbing,
// refresh on 401 through the vault). Reads retry on 429/5xx; the payroll
// update never retries an ambiguous failure itself (the engine re-prepares).
// Everything here is UNVERIFIED-LIVE: tested against documented example
// payloads and a labelled fake Gusto until demo keys exist.

import { ConnectorApiError, liveRequest, type LiveDeps, type TokenSource } from "@/lib/connectors/m21/live/http";
import { gustoBaseUrl } from "./env";

const PROVIDER = "Gusto";
export const GUSTO_DEFAULT_API_VERSION = "2026-06-15";
/** Gusto's documented maximum page size (employees, payrolls, compensations). */
export const GUSTO_PAGE_SIZE = 100;
const MAX_PAGES = 20;

export { GUSTO_DEMO_BASE_URL, GUSTO_PRODUCTION_BASE_URL, gustoBaseUrl, gustoEnvironment, type GustoEnvironment } from "./env";

export function gustoApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.GUSTO_API_VERSION ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : GUSTO_DEFAULT_API_VERSION;
}

export interface GustoAuth extends TokenSource {
  /** The one company this token covers (from /v1/token_info when absent). */
  companyUuid?: string | null;
}

// ---------------------------------------------------------------------------
// Documented shapes (the subset ShapesOS reads)
// ---------------------------------------------------------------------------

export interface GustoEmployee {
  uuid: string;
  first_name?: string | null;
  last_name?: string | null;
  preferred_first_name?: string | null;
  email?: string | null;
  work_email?: string | null;
  terminated?: boolean;
  onboarded?: boolean;
  jobs?: Array<{ uuid: string; primary?: boolean; title?: string | null; payment_unit?: string | null }>;
}

export interface GustoPayPeriod {
  start_date: string;
  end_date: string;
  pay_schedule_uuid?: string | null;
}

export interface GustoFixedCompensation {
  name: string;
  amount: string;
  job_uuid?: string | null;
}

export interface GustoHourlyCompensation {
  name: string;
  hours: string;
  amount?: string | null;
  job_uuid?: string | null;
  compensation_multiplier?: number | null;
}

export interface GustoEmployeeCompensation {
  employee_uuid: string;
  version?: string;
  excluded?: boolean;
  first_name?: string | null;
  last_name?: string | null;
  gross_pay?: string | null;
  net_pay?: string | null;
  check_amount?: string | null;
  payment_method?: string | null;
  fixed_compensations?: GustoFixedCompensation[];
  hourly_compensations?: GustoHourlyCompensation[];
  paid_time_off?: Array<{ name: string; hours: string }>;
  reimbursements?: Array<{ amount: string; description: string | null }>;
  taxes?: Array<{ name: string; employer: boolean; amount: string | number }>;
  benefits?: Array<{ name?: string; employee_deduction?: string | number; company_contribution?: string | number; imputed?: boolean }>;
  deductions?: Array<{ name?: string; amount?: string | number }>;
}

export interface GustoPayroll {
  payroll_uuid: string;
  uuid?: string;
  company_uuid?: string;
  processed: boolean;
  processed_date?: string | null;
  calculated_at?: string | null;
  check_date?: string | null;
  payroll_deadline?: string | null;
  off_cycle?: boolean;
  pay_period: GustoPayPeriod;
  processing_request?: { status?: string; errors?: unknown[] } | null;
  totals?: Record<string, string> | null;
  employee_compensations?: GustoEmployeeCompensation[];
  fixed_compensation_types?: Array<{ name: string }>;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

function request<T>(auth: GustoAuth, path: string, init: { method?: "GET" | "PUT"; query?: Record<string, string | number | undefined>; json?: unknown } = {}, deps: LiveDeps = {}): Promise<T> {
  return liveRequest<T>(
    {
      provider: PROVIDER,
      url: `${gustoBaseUrl()}${path}`,
      method: init.method ?? "GET",
      query: init.query,
      json: init.json,
      auth: { token: auth.token, refresh: auth.refresh },
      headers: { "X-Gusto-API-Version": gustoApiVersion() },
    },
    deps,
  );
}

const enc = encodeURIComponent;

/** The company the token covers (strict access: exactly one). */
export async function gustoCompanyUuid(auth: GustoAuth, deps: LiveDeps = {}): Promise<string> {
  if (auth.companyUuid) return auth.companyUuid;
  const info = await request<{ resource?: { type?: string; uuid?: string } }>(auth, "/v1/token_info", {}, deps);
  if (info?.resource?.type !== "Company" || !info.resource.uuid) {
    throw new ConnectorApiError(PROVIDER, "forbidden", "This Gusto token is not for a company — reconnect Gusto as a company admin.");
  }
  auth.companyUuid = info.resource.uuid;
  return info.resource.uuid;
}

async function pages<T>(fetchPage: (page: number) => Promise<T[] | null>): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = (await fetchPage(page)) ?? [];
    items.push(...batch);
    // liveRequest returns the body only; a short page is the last one
    // (Gusto also sends X-Total-Pages).
    if (batch.length < GUSTO_PAGE_SIZE) return { items, truncated: false };
  }
  return { items, truncated: true };
}

export async function gustoEmployees(auth: GustoAuth, deps: LiveDeps = {}): Promise<{ items: GustoEmployee[]; truncated: boolean }> {
  const company = await gustoCompanyUuid(auth, deps);
  return pages((page) => request<GustoEmployee[]>(auth, `/v1/companies/${enc(company)}/employees`, { query: { page, per: GUSTO_PAGE_SIZE } }, deps));
}

export async function gustoPayrolls(
  auth: GustoAuth,
  q: { processingStatuses: "unprocessed" | "processed" | "processed,unprocessed"; startDate: string; endDate: string },
  deps: LiveDeps = {},
): Promise<GustoPayroll[]> {
  const company = await gustoCompanyUuid(auth, deps);
  const r = await pages((page) =>
    request<GustoPayroll[]>(
      auth,
      `/v1/companies/${enc(company)}/payrolls`,
      { query: { processing_statuses: q.processingStatuses, payroll_types: "regular", start_date: q.startDate, end_date: q.endDate, page, per: GUSTO_PAGE_SIZE } },
      deps,
    ),
  );
  return r.items;
}

/** PUT …/prepare for the given employees (≤ 100) → versions + current compensations. */
export async function gustoPreparePayroll(auth: GustoAuth, payrollUuid: string, employeeUuids: string[], deps: LiveDeps = {}): Promise<GustoPayroll> {
  const company = await gustoCompanyUuid(auth, deps);
  return request<GustoPayroll>(auth, `/v1/companies/${enc(company)}/payrolls/${enc(payrollUuid)}/prepare`, { method: "PUT", query: { per: GUSTO_PAGE_SIZE }, json: { employee_uuids: employeeUuids } }, deps);
}

export interface GustoPayrollUpdate {
  employee_compensations: Array<{
    employee_uuid: string;
    version: string;
    hourly_compensations?: Array<{ name: string; hours: string; job_uuid?: string }>;
    fixed_compensations?: Array<{ name: string; amount: string; job_uuid?: string }>;
  }>;
}

/** PUT the update (no automatic retry: a 409 means "re-prepare", never "resend"). */
export async function gustoUpdatePayroll(auth: GustoAuth, payrollUuid: string, body: GustoPayrollUpdate, deps: LiveDeps = {}): Promise<GustoPayroll> {
  const company = await gustoCompanyUuid(auth, deps);
  return request<GustoPayroll>(auth, `/v1/companies/${enc(company)}/payrolls/${enc(payrollUuid)}`, { method: "PUT", json: body }, { ...deps, maxRetries: 0 });
}

/** One payroll with per-employee taxes, benefits and deductions (processed/calculated only). */
export async function gustoPayroll(auth: GustoAuth, payrollUuid: string, deps: LiveDeps = {}): Promise<GustoPayroll> {
  const company = await gustoCompanyUuid(auth, deps);
  // employee_compensations are paginated (max 100 per page): merge the pages.
  let first: GustoPayroll | null = null;
  const comps: GustoEmployeeCompensation[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const p = await request<GustoPayroll>(auth, `/v1/companies/${enc(company)}/payrolls/${enc(payrollUuid)}`, { query: { include: "taxes,benefits,deductions", page, per: GUSTO_PAGE_SIZE } }, deps);
    first ??= p;
    const batch = p?.employee_compensations ?? [];
    comps.push(...batch);
    if (batch.length < GUSTO_PAGE_SIZE) break;
  }
  if (!first) throw new ConnectorApiError(PROVIDER, "provider_error", "Gusto returned no payroll.");
  return { ...first, employee_compensations: comps };
}
